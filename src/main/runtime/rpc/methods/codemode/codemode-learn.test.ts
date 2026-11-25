import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodemodeLearnListView,
  CodemodeLearnRun,
  CodemodeLearnStatusView
} from '../../../../../shared/codemode/codemode-learn-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type {
  LearnChainJournal,
  LearnChainRecord
} from '../../../../codemode/learn/codemode-learn-journal-source'
import {
  inProcessLearnStore,
  type CodemodeLearnRemote
} from '../../../../codemode/learn/store/codemode-learn-ops'
import { CodemodeLearnStore } from '../../../../codemode/learn/store/codemode-learn-store'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import {
  codemodeLearnMethods,
  removeLearnStoreFiles,
  type CodemodeLearnMethodDeps
} from './codemode-learn'

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const SCRIPT = `const u = await mcp.crm.find({ q: 'a' }); return mcp.crm.update(u.id)`
const CHAIN = ['crm.find', 'crm.update', 'mail.send']

let dir: string
let store: CodemodeLearnStore
let remote: CodemodeLearnRemote
let enabled: boolean
let fileExists: boolean
let now: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-learn-rpc-'))
  store = CodemodeLearnStore.open(join(dir, 'codemode-learn.sqlite'), { clock: () => NOW })
  remote = inProcessLearnStore(() => store)
  enabled = true
  fileExists = true
  now = NOW
})
afterEach(() => {
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const run = (runId: string, sessionId: string): CodemodeLearnRun => ({
  runId,
  sessionId,
  projectRoot: '/repo',
  startedAt: NOW - 1000,
  ms: 20,
  ok: true,
  code: SCRIPT,
  calls: [0, 1].map((seq) => ({ seq, tool: `mcp.crm.t${seq}`, input: {}, ok: true, ms: 1 }))
})

/** Two chats that each made the calls in CHAIN, in one turn. */
function journal(): LearnChainJournal & { point: ReturnType<typeof vi.fn> } {
  const point = vi.fn(async () => ({
    kind: 'tool-call-names' as const,
    nextOrdinal: null,
    calls: CHAIN.map((key, ordinal) => {
      const [server, tool] = key.split('.')
      return {
        ordinal,
        observedAt: NOW - MINUTE,
        turnItemId: 'turn-1',
        agentId: null,
        name: `mcp__${server}__${tool}`,
        mcpServer: null,
        mcpTool: null
      }
    })
  }))
  const record = (sessionId: string): LearnChainRecord => ({
    sessionId,
    updatedAt: NOW - MINUTE,
    location: { executionHostId: LOCAL_EXECUTION_HOST_ID }
  })
  return { records: () => [record('s1'), record('s2')], readers: { point }, point }
}

function methodsFor(deps: Partial<CodemodeLearnMethodDeps> = {}) {
  const learnStore = vi.fn(() => remote)
  const closeLearnStore = vi.fn(async () => {})
  const removeStoreFiles = vi.fn(async () => {})
  const log = vi.fn()
  const methods = codemodeLearnMethods({
    desktop: () => true,
    service: async () => ({ learnEnabled: () => enabled, learnStore, closeLearnStore }),
    storeExists: async () => fileExists,
    removeStoreFiles,
    journal: async () => null,
    now: () => now,
    log,
    ...deps
  })
  const ctx: RpcContext = { runtime: new OrcaRuntimeService(null) }
  const call = async (name: string, params?: unknown): Promise<unknown> => {
    const method = eraseRpcMethods(methods).find((m) => m.name === name)
    if (!method) {
      throw new Error(`no method ${name}`)
    }
    // The dispatcher parses params before a handler runs; do the same here.
    return await method.handler(method.params?.parse(params) ?? params, ctx)
  }
  const list = async (): Promise<CodemodeLearnListView> => {
    const reply = await call('codemode.learn.list')
    if (!isListView(reply)) {
      throw new Error('not a list view')
    }
    return reply
  }
  const status = async (): Promise<CodemodeLearnStatusView> => {
    const reply = await call('codemode.learn.status')
    if (!isStatusView(reply)) {
      throw new Error('not a status view')
    }
    return reply
  }
  return { call, list, status, learnStore, closeLearnStore, removeStoreFiles, log }
}

const isListView = (value: unknown): value is CodemodeLearnListView =>
  typeof value === 'object' && value !== null && 'scripts' in value && 'chains' in value
const isStatusView = (value: unknown): value is CodemodeLearnStatusView =>
  typeof value === 'object' && value !== null && 'enabled' in value && 'stats' in value

describe('codemode.learn.* RPC methods', () => {
  it('status: the switch and what is stored', async () => {
    await remote.record(run('r1', 's1'), NOW)
    const { status } = methodsFor()
    const view = await status()
    expect(view.enabled).toBe(true)
    expect(view.stats.runs).toBe(1)
    expect(view.stats.bytes).toBeGreaterThan(0)
  })

  it('switch off: no store is opened when no file exists, and nothing is listed', async () => {
    enabled = false
    fileExists = false
    const { call, learnStore, removeStoreFiles } = methodsFor()
    expect(await call('codemode.learn.status')).toEqual({
      enabled: false,
      stats: { runs: 0, calls: 0, bytes: 0, oldest: null }
    })
    expect(await call('codemode.learn.list')).toEqual({
      scripts: [],
      chains: [],
      chainsComputedAt: null
    })
    expect(await call('codemode.learn.clear')).toEqual({})
    await expect(call('codemode.learn.dismiss', { key: 'a' })).rejects.toThrow('Learn is off')
    expect(learnStore).not.toHaveBeenCalled()
    expect(removeStoreFiles).not.toHaveBeenCalled()
  })

  it('switch off with a store file: status reads it; Clear stops the worker and deletes the file', async () => {
    await remote.record(run('r1', 's1'), NOW)
    enabled = false
    const methods = methodsFor()
    expect(await methods.status()).toMatchObject({ enabled: false, stats: { runs: 1 } })
    methods.learnStore.mockClear()
    await methods.call('codemode.learn.clear')
    expect(methods.closeLearnStore).toHaveBeenCalledOnce()
    expect(methods.removeStoreFiles).toHaveBeenCalledOnce()
    expect(methods.closeLearnStore.mock.invocationCallOrder[0]).toBeLessThan(
      methods.removeStoreFiles.mock.invocationCallOrder[0] ?? 0
    )
    // No worker is started to empty a file about to be deleted.
    expect(methods.learnStore).not.toHaveBeenCalled()
  })

  it('switch on: Clear empties the store and keeps its file', async () => {
    await remote.record(run('r1', 's1'), NOW)
    const methods = methodsFor()
    await methods.call('codemode.learn.clear')
    expect((await remote.stats()).runs).toBe(0)
    expect(methods.removeStoreFiles).not.toHaveBeenCalled()
  })

  it('removeLearnStoreFiles deletes the store and its WAL and SHM files', async () => {
    const path = join(dir, 'gone.sqlite')
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      writeFileSync(file, 'x')
    }
    await removeLearnStoreFiles(path)
    expect([path, `${path}-wal`, `${path}-shm`].some((file) => existsSync(file))).toBe(false)
    // Nothing there is fine too.
    await expect(removeLearnStoreFiles(path)).resolves.toBeUndefined()
  })

  it('lists repeated scripts and refreshes stale chains from the journal', async () => {
    await remote.record(run('r1', 's1'), NOW)
    await remote.record(run('r2', 's2'), NOW)
    const source = journal()
    const { list } = methodsFor({ journal: async () => source })
    const listed = await list()
    expect(listed.scripts).toHaveLength(1)
    expect(listed.scripts[0]).toMatchObject({ kind: 'script', sessions: 2, sampleCode: SCRIPT })
    expect(listed.chains).toHaveLength(1)
    expect(listed.chains[0]).toMatchObject({ kind: 'chain', tools: CHAIN, sessions: 2 })
    expect(listed.chainsComputedAt).toBe(NOW)
    const reads = source.point.mock.calls.length

    // Within 10 minutes the saved chains are reused; after that they are computed again.
    now = NOW + 9 * MINUTE
    expect((await list()).chainsComputedAt).toBe(NOW)
    expect(source.point.mock.calls.length).toBe(reads)
    now = NOW + 11 * MINUTE
    const later = await list()
    expect(later.chainsComputedAt).toBe(now)
    expect(source.point.mock.calls.length).toBeGreaterThan(reads)
  })

  it('dismiss hides a script or a chain at once', async () => {
    await remote.record(run('r1', 's1'), NOW)
    await remote.record(run('r2', 's2'), NOW)
    const source = journal()
    const { call, list } = methodsFor({ journal: async () => source })
    const listed = await list()
    const reads = source.point.mock.calls.length
    await call('codemode.learn.dismiss', { key: listed.scripts[0]?.shape })
    await call('codemode.learn.dismiss', { key: listed.chains[0]?.signature })
    const after = await list()
    expect(after).toEqual({ scripts: [], chains: [], chainsComputedAt: NOW })
    // The cached chains were filtered, not recomputed.
    expect(source.point.mock.calls.length).toBe(reads)
  })

  it('without a chat host, or when a refresh fails, lists the saved chains', async () => {
    await remote.saveChains(
      [{ kind: 'chain', signature: 'k', tools: CHAIN, sessions: 2, occurrences: 2, lastSeen: NOW }],
      NOW - 60 * MINUTE
    )
    const noHost = methodsFor()
    const listed = await noHost.list()
    expect(listed.chains.map((chain) => chain.signature)).toEqual(['k'])
    expect(listed.chainsComputedAt).toBe(NOW - 60 * MINUTE)

    const failing = methodsFor({
      journal: async () => ({
        records: () => {
          throw new Error('records gone')
        },
        readers: { point: vi.fn() }
      })
    })
    const fallback = await failing.list()
    expect(fallback.chains.map((chain) => chain.signature)).toEqual(['k'])
    expect(failing.log).toHaveBeenCalledOnce()
  })

  it('a chain refresh that loses to Clear lists nothing from before it', async () => {
    const source = journal()
    let cleared = false
    source.point.mockImplementation(async () => {
      if (!cleared) {
        cleared = true
        await remote.clear(NOW + 1)
      }
      return { kind: 'tool-call-names', nextOrdinal: null, calls: [] }
    })
    const { list } = methodsFor({ journal: async () => source })
    const listed = await list()
    expect(listed).toEqual({ scripts: [], chains: [], chainsComputedAt: null })
  })

  it('works only in the desktop app', async () => {
    const { call } = methodsFor({ desktop: () => false })
    await expect(call('codemode.learn.status')).rejects.toThrow(
      'code mode is only available in the desktop app'
    )
  })

  it('refuses a dismiss without a key or with extra fields', async () => {
    const { call } = methodsFor()
    await expect(call('codemode.learn.dismiss', { key: '' })).rejects.toThrow()
    await expect(call('codemode.learn.dismiss', { key: 'a', other: 1 })).rejects.toThrow()
  })
})
