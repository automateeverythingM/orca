import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodemodeLearnProposalState,
  CodemodeRepeatedChain
} from '../../../shared/codemode/codemode-learn-types'
import {
  CHAIN_UNTESTED_REASON,
  CodemodeLearnRunner,
  LEARN_STOPPED_REASON,
  runLearn,
  type LearnPipelineDeps
} from './codemode-learn-pipeline'
import { inProcessLearnStore, type CodemodeLearnRemote } from './store/codemode-learn-ops'
import { CodemodeLearnStore } from './store/codemode-learn-store'
import { bundleTestWorker } from './testing/codemode-test-worker'
import { SIGNAL_NOW, draftReply, fakeGenerate, recordSignal } from './testing/learn-signal-fixtures'
import type { LearnWriterGenerate } from './writer/codemode-learn-writer'

const NOT_SAVED: CodemodeLearnProposalState[] = ['writing', 'testing', 'ready', 'failed']
const CHAIN: CodemodeRepeatedChain = {
  kind: 'chain',
  signature: 'crm.find>crm.update>mail.send',
  tools: ['crm.find', 'crm.update', 'mail.send'],
  sessions: 3,
  occurrences: 4,
  lastSeen: SIGNAL_NOW - 10
}

let worker: Awaited<ReturnType<typeof bundleTestWorker>>
let dir: string
let store: CodemodeLearnStore
let remote: CodemodeLearnRemote

beforeAll(async () => {
  worker = await bundleTestWorker()
}, 30_000)
afterAll(() => worker.dispose())
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-learn-pipeline-'))
  store = CodemodeLearnStore.open(join(dir, 'learn.sqlite'), { clock: () => SIGNAL_NOW })
  remote = inProcessLearnStore(() => store)
})
afterEach(() => {
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function deps(over: Partial<LearnPipelineDeps> = {}): LearnPipelineDeps {
  return {
    store: remote,
    chains: async () => [],
    generate: fakeGenerate(),
    signal: new AbortController().signal,
    log: vi.fn(),
    workerPath: worker.workerPath,
    ...over
  }
}

const learn = (
  over: Partial<LearnPipelineDeps> = {},
  opts: { sessionId?: string; shape?: string } = {}
) => runLearn(deps(over), { now: SIGNAL_NOW, ...opts })

describe('runLearn', () => {
  it('runs top signals up to 5', async () => {
    for (let i = 0; i < 6; i++) {
      await recordSignal(remote, i)
    }
    const generate = vi.fn(fakeGenerate())
    const { proposals } = await learn({ generate })
    expect(proposals).toHaveLength(5)
    expect(generate).toHaveBeenCalledTimes(5)
    const stored = await remote.proposals(50)
    expect(stored.map((p) => p.name).sort()).toEqual(['plan1', 'plan2', 'plan3', 'plan4', 'plan5'])
    for (const p of stored) {
      expect(p).toMatchObject({
        state: 'ready',
        testStatus: 'passed',
        sourceKind: 'script',
        sourceSessions: 2,
        projectRoot: '/repo',
        callsBefore: 2,
        scope: 'project'
      })
      expect(p.source).toContain('@saved-by learn')
      expect(p.testLog).toContain('✓ mcp.')
    }
    // A second run skips the sources that already have a proposal.
    expect((await learn({ generate })).proposals).toHaveLength(1)
    expect((await remote.proposals(50)).filter((p) => p.name === 'plan0')).toHaveLength(1)
  })

  it('marks a chain untested and a script whose replay fails as ready with a failed test', async () => {
    await recordSignal(remote, 1)
    const generate = fakeGenerate(async (i) =>
      i === 1 ? { ok: true, text: draftReply(1, { expect: ['enterprise'] }) } : undefined
    )
    await learn({ generate, chains: async () => [CHAIN] })
    const byKind = Object.fromEntries((await remote.proposals(10)).map((p) => [p.sourceKind, p]))
    expect(byKind.chain).toMatchObject({
      state: 'ready',
      testStatus: 'untested',
      testReason: CHAIN_UNTESTED_REASON,
      projectRoot: null,
      callsBefore: 3,
      sourceKey: CHAIN.signature
    })
    expect(byKind.script).toMatchObject({
      state: 'ready',
      testStatus: 'failed',
      testReason: 'the result does not contain "enterprise"'
    })
  })

  it('writer failure marks failed and continues', async () => {
    for (let i = 0; i < 3; i++) {
      await recordSignal(remote, i)
    }
    const generate = fakeGenerate(async (i) => {
      if (i === 2) {
        return { ok: false, error: 'Claude is not logged in' }
      }
      return i === 1 ? { ok: true, text: 'no json here' } : undefined
    })
    const { proposals } = await learn({ generate })
    expect(proposals).toHaveLength(3)
    const bySource = await remote.proposals(10)
    const failed = bySource.filter((p) => p.state === 'failed')
    expect(failed).toHaveLength(2)
    expect(failed.map((p) => p.error).join('\n')).toContain('Claude is not logged in')
    expect(bySource.filter((p) => p.state === 'ready').map((p) => p.name)).toEqual(['plan0'])
  })

  it('late result never overrides a dismiss while the writer is pending', async () => {
    await recordSignal(remote, 1)
    const generate: LearnWriterGenerate = async () => {
      const [pending] = await remote.proposals(1)
      expect(pending?.state).toBe('writing')
      await remote.updateProposal(pending!.id, { state: 'dismissed' }, NOT_SAVED)
      return { ok: true, text: draftReply(1) }
    }
    await learn({ generate })
    const [p] = await remote.proposals(1)
    expect(p).toMatchObject({ state: 'dismissed' })
    expect(p?.name).toBeUndefined()
    expect(p?.testStatus).toBeUndefined()
  })

  it('late result never overrides a save while testing', async () => {
    await recordSignal(remote, 1)
    // The proposal is saved the moment it starts testing; the replay result must not land.
    const watched: CodemodeLearnRemote = {
      ...remote,
      updateProposal: async (id, patch, onlyFrom) => {
        const done = await remote.updateProposal(id, patch, onlyFrom)
        if (done && patch.state === 'testing') {
          await remote.updateProposal(id, { state: 'saved', savedAt: 1 }, ['testing'])
        }
        return done
      }
    }
    await learn({ store: watched })
    const [p] = await remote.proposals(1)
    expect(p).toMatchObject({ state: 'saved', name: 'plan1', savedAt: 1 })
    expect(p?.testStatus).toBeUndefined()
    expect(p?.testLog).toBeUndefined()
  })

  it('clear during a run leaves no proposals', async () => {
    for (let i = 0; i < 3; i++) {
      await recordSignal(remote, i)
    }
    const generate = vi.fn<LearnWriterGenerate>(async (prompt) => {
      await remote.clear(SIGNAL_NOW + 1)
      return { ok: true, text: draftReply(Number(/mcp\.s(\d+)/.exec(prompt)?.[1])) }
    })
    expect((await learn({ generate })).proposals).toEqual([])
    expect(await remote.proposals(10)).toEqual([])
    // The next signal's proposal is refused, so the run stops there.
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('an abort stops the writer and the run', async () => {
    for (let i = 0; i < 3; i++) {
      await recordSignal(remote, i)
    }
    const controller = new AbortController()
    const generate = vi.fn<LearnWriterGenerate>(
      (_prompt, opts) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'canceled' }))
          controller.abort()
        })
    )
    await learn({ generate, signal: controller.signal })
    expect(generate).toHaveBeenCalledTimes(1)
    const all = await remote.proposals(10)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ state: 'failed', error: LEARN_STOPPED_REASON })
  })

  it('a proposal an earlier run left unfinished is marked failed', async () => {
    const left = (await remote.createProposal(
      {
        sourceKind: 'script',
        sourceKey: 'old',
        sourceSessions: 2,
        projectRoot: null,
        callsBefore: 2
      },
      SIGNAL_NOW
    ))!
    await learn()
    expect(await remote.proposal(left.id)).toMatchObject({
      state: 'failed',
      error: LEARN_STOPPED_REASON
    })
  })

  it('sessionId and shape filters', async () => {
    await recordSignal(remote, 1)
    const two = await recordSignal(remote, 2, ['s2', 's9'])
    const three = await recordSignal(remote, 3)
    const chains = async () => [CHAIN]
    await learn({ chains }, { sessionId: 's9' })
    expect((await remote.proposals(10)).map((p) => p.sourceKey)).toEqual([two])
    await learn({ chains }, { shape: three })
    expect((await remote.proposals(10)).map((p) => p.sourceKey)).toEqual([three, two])
    await learn({ chains }, { shape: CHAIN.signature })
    expect((await remote.proposals(1))[0]?.sourceKind).toBe('chain')
    // A chain carries no chats, so a chat filter never picks one.
    expect(
      (await learn({ chains }, { sessionId: 's1', shape: CHAIN.signature })).proposals
    ).toEqual([])
  })

  it('passes the hint to the writer', async () => {
    await recordSignal(remote, 1)
    const generate = vi.fn(fakeGenerate())
    await runLearn(deps({ generate }), { now: SIGNAL_NOW, hint: 'look for plan lookups' })
    expect(generate.mock.calls[0]?.[0]).toContain('look for plan lookups')
  })
})

describe('CodemodeLearnRunner', () => {
  it('single flight', async () => {
    const runner = new CodemodeLearnRunner()
    let finish: (value: { proposals: string[] }) => void = () => {}
    let seen: AbortSignal | undefined
    const first = runner.start((signal) => {
      seen = signal
      return new Promise((resolve) => (finish = resolve))
    })
    expect(first).not.toBeNull()
    expect(runner.running()).toBe(true)
    expect(runner.start(async () => ({ proposals: [] }))).toBeNull()
    runner.stop()
    expect(seen?.aborted).toBe(true)
    finish({ proposals: ['a'] })
    await expect(first).resolves.toEqual({ proposals: ['a'] })
    expect(runner.running()).toBe(false)
    await expect(runner.start(async () => ({ proposals: ['b'] }))).resolves.toEqual({
      proposals: ['b']
    })
  })

  it('a failed run frees the runner', async () => {
    const runner = new CodemodeLearnRunner()
    const failing = async (): Promise<never> => {
      throw new Error('boom')
    }
    await expect(runner.start(failing)).rejects.toThrow('boom')
    expect(runner.running()).toBe(false)
    // A run that throws before it returns a promise frees the runner too.
    await expect(
      runner.start(() => {
        throw new Error('sync')
      })
    ).rejects.toThrow('sync')
    expect(runner.running()).toBe(false)
  })
})
