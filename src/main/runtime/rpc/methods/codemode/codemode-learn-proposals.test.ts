import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodemodeLearnRunner } from '../../../../codemode/learn/codemode-learn-pipeline'
import {
  inProcessLearnStore,
  type CodemodeLearnRemote
} from '../../../../codemode/learn/store/codemode-learn-ops'
import { CodemodeLearnStore } from '../../../../codemode/learn/store/codemode-learn-store'
import { bundleTestWorker } from '../../../../codemode/learn/testing/codemode-test-worker'
import {
  SIGNAL_NOW,
  fakeGenerate,
  recordSignal
} from '../../../../codemode/learn/testing/learn-signal-fixtures'
import type { LearnWriterGenerate } from '../../../../codemode/learn/writer/codemode-learn-writer'
import { CodemodeLibTrust } from '../../../../codemode/lib/codemode-lib-trust'
import {
  createLibRecords,
  type CodemodeLibRecords
} from '../../../../codemode/lib/codemode-lib-access'
import { makeReadyProposal, proposalRpc, view } from './codemode-learn-proposals.test-fixtures'

let worker: Awaited<ReturnType<typeof bundleTestWorker>>
let dir: string
let home: string
let root: string
let store: CodemodeLearnStore
let remote: CodemodeLearnRemote
let records: CodemodeLibRecords
let runner: CodemodeLearnRunner
let enabled: boolean
let generate: LearnWriterGenerate

beforeAll(async () => {
  worker = await bundleTestWorker()
}, 30_000)
afterAll(() => worker.dispose())
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-learn-proposals-rpc-'))
  home = mkdtempSync(join(dir, 'home-'))
  root = realpathSync(mkdtempSync(join(dir, 'repo-')))
  store = CodemodeLearnStore.open(join(dir, 'learn.sqlite'), { clock: () => SIGNAL_NOW })
  remote = inProcessLearnStore(() => store)
  records = createLibRecords(home)
  runner = new CodemodeLearnRunner()
  enabled = true
  generate = fakeGenerate()
})
afterEach(() => {
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function methods() {
  return proposalRpc({
    learnEnabled: () => enabled,
    remote: () => remote,
    runner: () => runner,
    records: () => records,
    generate: () => generate,
    root: () => root,
    workerPath: worker.workerPath
  })
}

const readyProposal = (i: number, projectRoot: string | null) =>
  makeReadyProposal(remote, i, projectRoot)

describe('codemode.learn.propose', () => {
  it('propose refused when Learn is off', async () => {
    enabled = false
    const call = methods()
    await expect(call('codemode.learn.propose', {})).resolves.toEqual({
      started: false,
      code: 'off',
      reason: 'Learn is off'
    })
    expect(runner.running()).toBe(false)
    await expect(view(call)).resolves.toEqual({ running: false, proposals: [], usage: {} })
    await expect(call('codemode.learn.dismissProposal', { id: 'x' })).rejects.toThrow(
      'Learn is off'
    )
  })

  it('starts the run in the background and refuses a second one while it runs', async () => {
    await recordSignal(remote, 1, ['s1', 's2'], root)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    generate = async (prompt, opts) => {
      await gate
      return fakeGenerate()(prompt, opts)
    }
    const call = methods()
    await expect(call('codemode.learn.propose', { hint: 'plans' })).resolves.toEqual({
      started: true
    })
    expect((await view(call)).running).toBe(true)
    await expect(call('codemode.learn.propose', {})).resolves.toEqual({
      started: false,
      code: 'running',
      reason: 'Learn is already running'
    })
    release()
    await vi.waitFor(() => expect(runner.running()).toBe(false), { timeout: 10_000 })
    const after = await view(call)
    expect(after.running).toBe(false)
    expect(after.proposals).toHaveLength(1)
    expect(after.proposals[0]).toMatchObject({
      state: 'ready',
      testStatus: 'passed',
      projectRoot: root,
      createdAt: SIGNAL_NOW + 5
    })
  })
})

describe('codemode.learn.saveProposal', () => {
  it('saveProposal writes the lib file with @saved-by learn and trusts it', async () => {
    const p = await readyProposal(1, root)
    const call = methods()
    await expect(
      call('codemode.learn.saveProposal', { id: p.id, scope: 'project' })
    ).resolves.toEqual({ name: 'plan1', scope: 'project' })
    const text = readFileSync(join(root, '.orca', 'lib', 'plan1.js'), 'utf8')
    expect(text).toContain('@saved-by learn')
    expect(text).toContain('async function plan1({ q })')
    await expect(records.trust.state(root, 'plan1', text)).resolves.toBe('trusted')
    expect(await remote.proposal(p.id)).toMatchObject({
      state: 'saved',
      savedAs: { name: 'plan1', scope: 'project' },
      savedAt: SIGNAL_NOW + 5,
      source: text
    })
    // Saved only once, and never from writing or testing.
    await expect(
      call('codemode.learn.saveProposal', { id: p.id, scope: 'global' })
    ).rejects.toThrow('already saved')
    const writing = (await remote.createProposal(
      {
        sourceKind: 'script',
        sourceKey: 'w',
        sourceSessions: 2,
        projectRoot: root,
        callsBefore: 2
      },
      SIGNAL_NOW
    ))!
    await expect(
      call('codemode.learn.saveProposal', { id: writing.id, scope: 'global', source: text })
    ).rejects.toThrow('not ready')
    await expect(
      call('codemode.learn.saveProposal', { id: 'nope', scope: 'global' })
    ).rejects.toThrow('unknown proposal')
  })

  it('edited source is validated, and a valid edit is what gets saved', async () => {
    const p = await readyProposal(2, root)
    const call = methods()
    await expect(
      call('codemode.learn.saveProposal', { id: p.id, scope: 'global', source: 'const x = 1' })
    ).rejects.toThrow('source must define function plan2')
    expect((await remote.proposal(p.id))?.state).toBe('ready')
    const edited = p.source!.replace('return await', 'const out = await')
    const fixed = edited.replace(/\n}\n?$/, '\n  return out\n}\n')
    await call('codemode.learn.saveProposal', { id: p.id, scope: 'global', source: fixed })
    const text = readFileSync(join(home, '.orca', 'lib', 'plan2.js'), 'utf8')
    expect(text).toContain('return out')
    expect(text).toContain('@saved-by learn')
    await expect(records.trust.state('~', 'plan2', text)).resolves.toBe('trusted')
  })

  it('a failed proposal with a function can still be saved', async () => {
    const p = await readyProposal(3, root)
    await remote.updateProposal(p.id, { state: 'failed', error: 'x' }, ['ready'])
    await methods()('codemode.learn.saveProposal', { id: p.id, scope: 'global' })
    expect((await remote.proposal(p.id))?.state).toBe('saved')
  })

  it('unknown project refused', async () => {
    const elsewhere = await readyProposal(1, '/not/a/worktree')
    const none = await readyProposal(2, null)
    const call = methods()
    await expect(
      call('codemode.learn.saveProposal', { id: elsewhere.id, scope: 'project' })
    ).rejects.toThrow('unknown project')
    await expect(
      call('codemode.learn.saveProposal', { id: none.id, scope: 'project' })
    ).rejects.toThrow('no project')
    expect((await remote.proposal(elsewhere.id))?.state).toBe('ready')
    // Global scope needs no project.
    await call('codemode.learn.saveProposal', { id: elsewhere.id, scope: 'global' })
    expect((await remote.proposal(elsewhere.id))?.state).toBe('saved')
  })
})

describe('codemode.learn.dismissProposal and usage', () => {
  it('dismisses any proposal not saved', async () => {
    const p = await readyProposal(1, root)
    const call = methods()
    await expect(call('codemode.learn.dismissProposal', { id: p.id })).resolves.toEqual({})
    expect((await remote.proposal(p.id))?.state).toBe('dismissed')
    await expect(call('codemode.learn.dismissProposal', { id: p.id })).resolves.toEqual({})
    const saved = await readyProposal(2, root)
    await call('codemode.learn.saveProposal', { id: saved.id, scope: 'global' })
    await expect(call('codemode.learn.dismissProposal', { id: saved.id })).rejects.toThrow(
      'already saved'
    )
    await expect(call('codemode.learn.dismissProposal', { id: 'nope' })).rejects.toThrow(
      'unknown proposal'
    )
  })

  it('usage counts uses and gives callsAfter once used 3 times', async () => {
    const p = await readyProposal(1, root)
    const call = methods()
    await call('codemode.learn.saveProposal', { id: p.id, scope: 'project' })
    expect((await view(call)).usage).toEqual({ [p.id]: { uses: 0, callsAfter: null } })
    for (const [n, tools] of [['lib.plan1'], ['lib.plan1', 'mcp.s1.get']].entries()) {
      await remote.record(
        {
          runId: `after-${n}`,
          sessionId: `s${n}`,
          projectRoot: root,
          startedAt: SIGNAL_NOW + 10,
          ms: 1,
          ok: true,
          code: 'return lib.plan1({ q: "a" })',
          calls: tools.map((tool, seq) => ({ seq, tool, input: {}, ok: true, ms: 1 }))
        },
        SIGNAL_NOW
      )
      await records.usage.recordUse(root, 'plan1')
    }
    expect((await view(call)).usage[p.id]).toEqual({ uses: 2, callsAfter: null })
    await records.usage.recordUse(root, 'plan1')
    expect((await view(call)).usage[p.id]).toEqual({ uses: 3, callsAfter: 1.5 })
  })
})

/** Trust whose `record` waits for the test, or fails. */
class HeldTrust extends CodemodeLibTrust {
  reached = false
  release: () => void = () => {}
  fail = false
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve))

  override async record(key: string, name: string, source: string): Promise<void> {
    this.reached = true
    if (this.fail) {
      throw new Error('trust file is read-only')
    }
    await this.gate
    return super.record(key, name, source)
  }
}

describe('saving claims the proposal first', () => {
  it('a dismiss during the save is refused, and the save stands', async () => {
    const trust = new HeldTrust({ homeDir: home })
    records = { ...records, trust }
    const p = await readyProposal(1, root)
    const call = methods()
    const saving = call('codemode.learn.saveProposal', { id: p.id, scope: 'global' })
    await vi.waitFor(() => expect(trust.reached).toBe(true))
    await expect(call('codemode.learn.dismissProposal', { id: p.id })).rejects.toThrow(
      'already saved'
    )
    trust.release()
    await expect(saving).resolves.toEqual({ name: 'plan1', scope: 'global' })
    expect(await remote.proposal(p.id)).toMatchObject({
      state: 'saved',
      savedAs: { name: 'plan1', scope: 'global' }
    })
    expect(await remote.dismissed()).toEqual([])
  })

  it('a double save writes one file in one scope', async () => {
    const p = await readyProposal(1, root)
    const call = methods()
    const results = await Promise.allSettled([
      call('codemode.learn.saveProposal', { id: p.id, scope: 'global' }),
      call('codemode.learn.saveProposal', { id: p.id, scope: 'project' })
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected')
    expect(refused?.status === 'rejected' && String(refused.reason)).toContain('already saved')
    const files = [join(home, '.orca', 'lib', 'plan1.js'), join(root, '.orca', 'lib', 'plan1.js')]
    expect(files.filter((file) => existsSync(file))).toHaveLength(1)
  })

  it('a failed trust write gives the proposal back its state', async () => {
    const trust = new HeldTrust({ homeDir: home })
    trust.fail = true
    records = { ...records, trust }
    const p = await readyProposal(1, root)
    await expect(
      methods()('codemode.learn.saveProposal', { id: p.id, scope: 'global' })
    ).rejects.toThrow('trust file is read-only')
    expect((await remote.proposal(p.id))?.state).toBe('ready')
  })
})

describe('dismissing and clearing', () => {
  it('a dismissed proposal is not listed as a repeat or drafted again', async () => {
    const shape = await recordSignal(remote, 1, ['s1', 's2'], root)
    const call = methods()
    await call('codemode.learn.propose', {})
    await vi.waitFor(() => expect(runner.running()).toBe(false))
    const [p] = (await view(call)).proposals
    await call('codemode.learn.dismissProposal', { id: p!.id })
    expect(await remote.dismissed()).toEqual([shape])
    expect(await remote.repeatedScripts(SIGNAL_NOW, 50)).toEqual([])
    const generateCalls = vi.fn(fakeGenerate())
    generate = generateCalls
    await call('codemode.learn.propose', {})
    await vi.waitFor(() => expect(runner.running()).toBe(false))
    expect(generateCalls).not.toHaveBeenCalled()
    expect((await view(call)).proposals).toHaveLength(1)
  })

  it('Clear during a run stops it and leaves no proposals', async () => {
    await recordSignal(remote, 1, ['s1', 's2'], root)
    await recordSignal(remote, 2, ['s1', 's2'], root)
    let writing = false
    const pending = vi.fn<LearnWriterGenerate>(
      (_prompt, opts) =>
        new Promise((resolve) => {
          writing = true
          opts.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'canceled' }))
        })
    )
    generate = pending
    const call = methods()
    await call('codemode.learn.propose', {})
    await vi.waitFor(() => expect(writing).toBe(true))
    await call('codemode.learn.clear')
    await vi.waitFor(() => expect(runner.running()).toBe(false))
    expect(pending).toHaveBeenCalledOnce()
    expect(await remote.proposals(10)).toEqual([])
  })
})
