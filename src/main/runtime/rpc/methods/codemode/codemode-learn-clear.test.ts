// codemode.learn.clear when the store is big or damaged, and dismissing a chain too long to send raw.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodemodeLearnListView } from '../../../../../shared/codemode/codemode-learn-types'
import { chainCallKey, findRepeatedChains } from '../../../../codemode/learn/codemode-learn-chains'
import {
  inProcessLearnStore,
  type CodemodeLearnRemote
} from '../../../../codemode/learn/store/codemode-learn-ops'
import { CodemodeLearnStore } from '../../../../codemode/learn/store/codemode-learn-store'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { codemodeLearnMethods, removeLearnStoreFiles } from './codemode-learn'

const NOW = 1_800_000_000_000

let dir: string
const opened: CodemodeLearnStore[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-learn-clear-'))
})
afterEach(() => {
  for (const store of opened.splice(0)) {
    store.dispose()
  }
  rmSync(dir, { recursive: true, force: true })
})

function methodsFor(remote: CodemodeLearnRemote, removeStoreFiles = vi.fn(async () => {})) {
  const closeLearnStore = vi.fn(async () => {})
  const log = vi.fn()
  const methods = codemodeLearnMethods({
    desktop: () => true,
    service: async () => ({ learnEnabled: () => true, learnStore: () => remote, closeLearnStore }),
    storeExists: async () => true,
    removeStoreFiles,
    journal: async () => null,
    now: () => NOW,
    log
  })
  const ctx: RpcContext = { runtime: new OrcaRuntimeService(null) }
  const call = async (name: string, params?: unknown): Promise<unknown> => {
    const method = eraseRpcMethods(methods).find((m) => m.name === name)
    if (!method) {
      throw new Error(`no method ${name}`)
    }
    return await method.handler(method.params?.parse(params) ?? params, ctx)
  }
  return { call, closeLearnStore, removeStoreFiles, log }
}

const isListView = (value: unknown): value is CodemodeLearnListView =>
  typeof value === 'object' && value !== null && 'scripts' in value && 'chains' in value

/** A store whose clear and compact the test settles. */
function fakeClearStore(compact: () => Promise<void>) {
  const unused = (): Promise<never> => Promise.reject(new Error('not used in this test'))
  const clear = vi.fn(async () => {})
  const store: CodemodeLearnRemote = {
    record: unused,
    repeatedScripts: unused,
    runsForShape: unused,
    saveChains: unused,
    chains: unused,
    dismiss: unused,
    dismissed: unused,
    stats: unused,
    createProposal: unused,
    updateProposal: unused,
    proposals: unused,
    proposal: unused,
    openProposalKeys: unused,
    clear,
    compact: vi.fn(compact)
  }
  return { store, clear, compact: store.compact }
}

describe('codemode.learn.clear', () => {
  it('answers once the rows are deleted; shrinking the file runs after, and only logs a failure', async () => {
    let finishCompact: (error?: Error) => void = () => {}
    const fake = fakeClearStore(
      () =>
        new Promise<void>((resolve, reject) => {
          finishCompact = (error) => (error ? reject(error) : resolve())
        })
    )
    const methods = methodsFor(fake.store)
    // Clear answers although the compact has not finished.
    await expect(methods.call('codemode.learn.clear')).resolves.toEqual({})
    expect(fake.clear).toHaveBeenCalledOnce()
    expect(fake.compact).toHaveBeenCalledOnce()
    expect(fake.clear.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fake.compact).mock.invocationCallOrder[0] ?? 0
    )
    finishCompact(new Error('the Learn DB worker timed out after 300000ms'))
    await vi.waitFor(() => expect(methods.log).toHaveBeenCalledOnce())
    expect(methods.removeStoreFiles).not.toHaveBeenCalled()
  })

  it('a store file that will not open is closed and deleted with its -wal and -shm', async () => {
    const path = join(dir, 'codemode-learn.sqlite')
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      writeFileSync(file, 'this is not a SQLite database '.repeat(200))
    }
    const remote = inProcessLearnStore(() => CodemodeLearnStore.open(path))
    await expect(remote.stats()).rejects.toThrow()
    const methods = methodsFor(
      remote,
      vi.fn(() => removeLearnStoreFiles(path))
    )
    await expect(methods.call('codemode.learn.clear')).resolves.toEqual({})
    expect(methods.closeLearnStore).toHaveBeenCalledOnce()
    expect(methods.closeLearnStore.mock.invocationCallOrder[0]).toBeLessThan(
      methods.removeStoreFiles.mock.invocationCallOrder[0] ?? 0
    )
    expect([path, `${path}-wal`, `${path}-shm`].filter((file) => existsSync(file))).toEqual([])
    expect(methods.log).toHaveBeenCalledOnce()
  })
})

describe('codemode.learn.dismiss for a long chain', () => {
  it('a 100-call chain past the 64 KiB key cap is dismissed by its hashed key', async () => {
    const store = CodemodeLearnStore.open(join(dir, 'learn.sqlite'), { clock: () => NOW })
    opened.push(store)
    const remote = inProcessLearnStore(() => store)
    const name = (index: number) => `${'n'.repeat(400)}${index}`
    const tools = Array.from({ length: 100 }, (_, index) => chainCallKey(name(index), name(index)))
    const chains = findRepeatedChains(
      ['a', 'b'].map((sessionId) => ({ sessionId, turns: [{ tools, at: NOW }] })),
      NOW
    )
    await remote.saveChains(chains, NOW)
    const methods = methodsFor(remote)
    const listed = async () => {
      const view = await methods.call('codemode.learn.list')
      if (!isListView(view)) {
        throw new Error('not a list view')
      }
      return view.chains
    }
    const [chain] = await listed()
    expect(chain.tools).toHaveLength(100)
    await methods.call('codemode.learn.dismiss', { key: chain.signature })
    expect(await listed()).toEqual([])
  })
})
