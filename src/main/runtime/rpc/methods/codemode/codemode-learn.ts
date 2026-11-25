import { rm, stat } from 'node:fs/promises'
import type {
  CodemodeLearnListView,
  CodemodeLearnStats,
  CodemodeLearnStatusView,
  CodemodeRepeatedChain
} from '../../../../../shared/codemode/codemode-learn-types'
import { CodemodeLearnDismiss } from '../../../../../shared/rpc-contract/codemode/codemode-learn-params'
import { installedCodemodeService } from '../../../../codemode/codemode-process-service'
import type { CodemodeService } from '../../../../codemode/codemode-service'
import {
  chainsAreFresh,
  refreshChains,
  type LearnChainJournal,
  type LearnChainLog
} from '../../../../codemode/learn/codemode-learn-journal-source'
import { learnStorePath } from '../../../../codemode/learn/codemode-learn-recorder'
import type { CodemodeLearnRemote } from '../../../../codemode/learn/store/codemode-learn-ops'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod, type RpcContext } from '../../core'

/** Most repeated scripts listed. */
const LEARN_LIST_LIMIT = 50
const NO_STATS: CodemodeLearnStats = { runs: 0, calls: 0, bytes: 0, oldest: null }

type LearnService = Pick<CodemodeService, 'learnEnabled' | 'learnStore' | 'closeLearnStore'>

/** Deletes a Learn store file with its write-ahead log and shared-memory files; missing ones are fine. */
export async function removeLearnStoreFiles(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((file) => rm(file, { force: true })))
}

export type CodemodeLearnMethodDeps = {
  /** Code mode runs only in the desktop app (its worker and WASM ship only there). */
  desktop: () => boolean
  /** The process's one code-mode service: the Learn switch and the store its recorder writes. */
  service: (ctx: RpcContext) => Promise<LearnService>
  /** Whether the profile has a Learn store file; with the switch off, no worker starts without one. */
  storeExists: () => Promise<boolean>
  /** Deletes the store file (and its -wal/-shm); called only after the worker is closed. */
  removeStoreFiles: () => Promise<void>
  /** The chats' records and journal readers; null when no chat host is installed. */
  journal: (ctx: RpcContext) => Promise<LearnChainJournal | null>
  now: () => number
  log: LearnChainLog
}

async function runtimeService(ctx: RpcContext): Promise<LearnService> {
  // Why: the host's install creates the service; Settings must share its store, never open another.
  await ctx.runtime.ensureStructuredAgentSessionHost()
  const service = installedCodemodeService()
  if (!service) {
    throw new Error('Learn unavailable')
  }
  return service
}

async function runtimeJournal(ctx: RpcContext): Promise<LearnChainJournal | null> {
  await ctx.runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  return {
    records: () => host.deps.store.listRecords(),
    readers: host.deps.journalDatabase.readers
  }
}

const RUNTIME_DEPS: CodemodeLearnMethodDeps = {
  desktop: () => process.versions.electron !== undefined,
  service: runtimeService,
  storeExists: () =>
    stat(learnStorePath()).then(
      () => true,
      () => false
    ),
  removeStoreFiles: () => removeLearnStoreFiles(learnStorePath()),
  journal: runtimeJournal,
  now: Date.now,
  log: (message, error) => console.warn(`[codemode] ${message}`, error ?? '')
}

/** `codemode.learn.*`: Settings › Code mode › Learn. Each call is the person's own action there. */
export function codemodeLearnMethods(deps: CodemodeLearnMethodDeps) {
  const open = async (ctx: RpcContext) => {
    if (!deps.desktop()) {
      throw new Error('code mode is only available in the desktop app')
    }
    return deps.service(ctx)
  }

  /** The saved chains, computed again from the chats when older than 10 minutes. */
  const chains = async (
    ctx: RpcContext,
    store: CodemodeLearnRemote
  ): Promise<{ chains: CodemodeRepeatedChain[]; computedAt: number | null }> => {
    const saved = await store.chains()
    if (chainsAreFresh(saved.computedAt, deps.now())) {
      return saved
    }
    const journal = await deps.journal(ctx)
    if (!journal) {
      return saved
    }
    try {
      await refreshChains({ journal, store, now: deps.now, log: deps.log })
    } catch (error) {
      deps.log('Learn could not compute repeated chains; showing the saved ones', error)
      return saved
    }
    // Why: read back what was saved; a refresh that lost to Clear saved nothing and lists nothing.
    return store.chains()
  }

  return [
    defineMethod({
      name: 'codemode.learn.status',
      permission: 'workspace',
      params: null,
      handler: async (_params, ctx): Promise<CodemodeLearnStatusView> => {
        const service = await open(ctx)
        const enabled = service.learnEnabled()
        // Why: with the switch off, report what an earlier session left (so Clear can remove it)
        // without starting the worker when there is nothing on disk.
        const stats =
          enabled || (await deps.storeExists()) ? await service.learnStore().stats() : NO_STATS
        return { enabled, stats }
      }
    }),
    defineMethod({
      name: 'codemode.learn.list',
      permission: 'workspace',
      params: null,
      handler: async (_params, ctx): Promise<CodemodeLearnListView> => {
        const service = await open(ctx)
        if (!service.learnEnabled()) {
          return { scripts: [], chains: [], chainsComputedAt: null }
        }
        const store = service.learnStore()
        const scripts = await store.repeatedScripts(deps.now(), LEARN_LIST_LIMIT)
        const cached = await chains(ctx, store)
        // Why: a dismiss applies at once, without computing the chains again.
        const dismissed = new Set(await store.dismissed())
        return {
          scripts,
          chains: cached.chains.filter((chain) => !dismissed.has(chain.signature)),
          chainsComputedAt: cached.computedAt
        }
      }
    }),
    defineMethod({
      name: 'codemode.learn.dismiss',
      permission: 'workspace',
      params: CodemodeLearnDismiss,
      handler: async (params, ctx): Promise<Record<string, never>> => {
        const service = await open(ctx)
        if (!service.learnEnabled()) {
          throw new Error('Learn is off')
        }
        await service.learnStore().dismiss(params.key)
        return {}
      }
    }),
    defineMethod({
      name: 'codemode.learn.clear',
      permission: 'workspace',
      params: null,
      handler: async (_params, ctx): Promise<Record<string, never>> => {
        const service = await open(ctx)
        if (service.learnEnabled()) {
          await service.learnStore().clear()
        } else if (await deps.storeExists()) {
          // Why: with the switch off nothing should stay on disk, and a leftover file would start
          // the worker on every Settings visit; stop the worker first so the file is not in use.
          await service.closeLearnStore()
          await deps.removeStoreFiles()
        }
        return {}
      }
    })
  ]
}

export const CODEMODE_LEARN_METHODS = codemodeLearnMethods(RUNTIME_DEPS)
