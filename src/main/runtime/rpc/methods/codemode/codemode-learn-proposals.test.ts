import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalsView
} from '../../../../../shared/codemode/codemode-learn-types'
import {
  CodemodeLearnRunner,
  LEARN_STOPPED_REASON
} from '../../../../codemode/learn/codemode-learn-pipeline'
import {
  inProcessLearnStore,
  type CodemodeLearnRemote
} from '../../../../codemode/learn/store/codemode-learn-ops'
import { CodemodeLearnStore } from '../../../../codemode/learn/store/codemode-learn-store'
import { bundleTestWorker } from '../../../../codemode/learn/testing/codemode-test-worker'
import {
  SIGNAL_NOW,
  draftReply,
  fakeGenerate,
  recordSignal
} from '../../../../codemode/learn/testing/learn-signal-fixtures'
import type { LearnWriterGenerate } from '../../../../codemode/learn/writer/codemode-learn-writer'
import {
  draftToLibFile,
  parseWriterReply
} from '../../../../codemode/learn/writer/codemode-learn-writer-reply'
import { CodemodeLibStore } from '../../../../codemode/lib/codemode-lib-store'
import { CodemodeLibTrust } from '../../../../codemode/lib/codemode-lib-trust'
import {
  createLibRecords,
  type CodemodeLibRecords
} from '../../../../codemode/lib/codemode-lib-access'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { requireKnownProject } from './codemode-lib'
import { codemodeLearnMethods } from './codemode-learn'
import { codemodeLearnProposalMethods } from './codemode-learn-proposals'

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
  const service = {
    learnEnabled: () => enabled,
    learnStore: () => remote,
    learnRunner: () => runner,
    libRecords: () => records,
    closeLearnStore: async () => {}
  }
  const learn = codemodeLearnMethods({
    desktop: () => true,
    service: async () => service,
    storeExists: async () => true,
    removeStoreFiles: async () => {},
    journal: async () => null,
    now: () => SIGNAL_NOW + 5,
    log: vi.fn()
  })
  const proposals = codemodeLearnProposalMethods({
    desktop: () => true,
    service: async () => service,
    chains: async () => [],
    generate: () => generate,
    projectAccess: (_ctx, projectRoot) =>
      requireKnownProject(async () => ({ worktrees: [{ path: root }] }), projectRoot),
    now: () => SIGNAL_NOW + 5,
    log: vi.fn(),
    workerPath: worker.workerPath
  })
  const ctx: RpcContext = { runtime: new OrcaRuntimeService(null) }
  return async (name: string, params?: unknown): Promise<unknown> => {
    const method = [...eraseRpcMethods(learn), ...eraseRpcMethods(proposals)].find(
      (m) => m.name === name
    )
    if (!method) {
      throw new Error(`no method ${name}`)
    }
    return await method.handler(method.params?.parse(params) ?? params, ctx)
  }
}

const isView = (value: unknown): value is CodemodeLearnProposalsView =>
  typeof value === 'object' && value !== null && 'proposals' in value && 'usage' in value

async function view(call: ReturnType<typeof methods>): Promise<CodemodeLearnProposalsView> {
  const result = await call('codemode.learn.proposals')
  if (!isView(result)) {
    throw new Error('not a proposals view')
  }
  return result
}

/** A ready, passed proposal for signal `i`, as a finished run leaves it. */
async function readyProposal(
  i: number,
  projectRoot: string | null
): Promise<CodemodeLearnProposal> {
  const parsed = parseWriterReply(draftReply(i))
  if (!parsed.ok) {
    throw new Error(parsed.reason)
  }
  const { draft } = parsed
  const made = (await remote.createProposal(
    { sourceKind: 'script', sourceKey: `k${i}`, sourceSessions: 2, projectRoot, callsBefore: 2 },
    SIGNAL_NOW
  ))!
  await remote.updateProposal(
    made.id,
    { state: 'ready', name: draft.name, description: draft.description, params: draft.params },
    ['writing']
  )
  await remote.updateProposal(made.id, { source: draftToLibFile(draft).source }, ['ready'])
  return (await remote.proposal(made.id))!
}

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

/** A proposal for signal `i` that failed, as a run leaves it. */
async function failedProposal(
  i: number,
  failure: 'not-worth' | 'error' | undefined
): Promise<CodemodeLearnProposal> {
  const made = (await remote.createProposal(
    {
      sourceKind: 'script',
      sourceKey: `k${i}`,
      sourceSessions: 2,
      projectRoot: root,
      callsBefore: 2
    },
    SIGNAL_NOW
  ))!
  await remote.updateProposal(
    made.id,
    { state: 'failed', error: 'x', ...(failure ? { failure } : {}) },
    ['writing']
  )
  return (await remote.proposal(made.id))!
}

describe('dismissing failed proposals', () => {
  it('a card that failed on an error goes, but its source stays open', async () => {
    const call = methods()
    const errored = await failedProposal(1, 'error')
    const legacy = await failedProposal(2, undefined)
    await call('codemode.learn.dismissProposal', { id: errored.id })
    await call('codemode.learn.dismissProposal', { id: legacy.id })
    expect((await remote.proposal(errored.id))?.state).toBe('dismissed')
    expect((await remote.proposal(legacy.id))?.state).toBe('dismissed')
    expect(await remote.dismissed()).toEqual([])
  })

  it('a not-worth card or a ready card dismisses its source too', async () => {
    const call = methods()
    const notWorth = await failedProposal(1, 'not-worth')
    const ready = await readyProposal(2, root)
    await call('codemode.learn.dismissProposal', { id: notWorth.id })
    await call('codemode.learn.dismissProposal', { id: ready.id })
    expect((await remote.dismissed()).sort()).toEqual(['k1', 'k2'])
  })
})

describe('saving over an existing function', () => {
  it('refuses a name already saved in that scope, and gives the proposal back', async () => {
    const existing = 'async function plan1() {\n  return "mine"\n}\n'
    await new CodemodeLibStore({ projectRoot: null, homeDir: home }).save({
      name: 'plan1',
      source: existing,
      scope: 'global',
      description: "The person's own plan1",
      savedBy: 'user'
    })
    const file = join(home, '.orca', 'lib', 'plan1.js')
    const before = readFileSync(file, 'utf8')
    const p = await readyProposal(1, root)
    const call = methods()
    await expect(
      call('codemode.learn.saveProposal', { id: p.id, scope: 'global' })
    ).rejects.toThrow(
      'A function named plan1 already exists in global. Edit the name or delete the existing one.'
    )
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await remote.proposal(p.id))?.state).toBe('ready')
    // Project scope has no plan1 yet.
    await expect(
      call('codemode.learn.saveProposal', { id: p.id, scope: 'project' })
    ).resolves.toEqual({ name: 'plan1', scope: 'project' })
  })

  it('an edit that renames the function saves under the new name', async () => {
    await new CodemodeLibStore({ projectRoot: null, homeDir: home }).save({
      name: 'plan1',
      source: 'async function plan1() {\n  return 1\n}\n',
      scope: 'global',
      description: 'taken',
      savedBy: 'user'
    })
    const p = await readyProposal(1, root)
    const renamed = p.source!.replaceAll('plan1', 'planOne')
    await expect(
      methods()('codemode.learn.saveProposal', { id: p.id, scope: 'global', source: renamed })
    ).resolves.toEqual({ name: 'planOne', scope: 'global' })
    expect(readFileSync(join(home, '.orca', 'lib', 'planOne.js'), 'utf8')).toContain(
      'async function planOne({ q })'
    )
    expect(await remote.proposal(p.id)).toMatchObject({
      state: 'saved',
      savedAs: { name: 'planOne', scope: 'global' }
    })
  })

  it('the writer is told the saved names of the project and global scopes', async () => {
    await new CodemodeLibStore({ projectRoot: root, homeDir: home }).save({
      name: 'projectFn',
      source: 'async function projectFn() {\n  return 1\n}\n',
      scope: 'project',
      description: 'p',
      savedBy: 'user'
    })
    await new CodemodeLibStore({ projectRoot: null, homeDir: home }).save({
      name: 'globalFn',
      source: 'async function globalFn() {\n  return 1\n}\n',
      scope: 'global',
      description: 'g',
      savedBy: 'user'
    })
    await recordSignal(remote, 1, ['s1', 's2'], root)
    const prompts: string[] = []
    generate = async (prompt, opts) => {
      prompts.push(prompt)
      return fakeGenerate()(prompt, opts)
    }
    const call = methods()
    await call('codemode.learn.propose', {})
    await vi.waitFor(() => expect(runner.running()).toBe(false), { timeout: 10_000 })
    expect(prompts[0]).toMatch(/Do not reuse these names[^\n]*globalFn, projectFn/)
  })
})

describe('proposals with nothing behind them', () => {
  it('propose says nothing is new when every source is skipped', async () => {
    const call = methods()
    await expect(call('codemode.learn.propose', {})).resolves.toEqual({
      started: false,
      code: 'nothing-new',
      reason: 'Nothing new to learn here yet.'
    })
    expect(runner.running()).toBe(false)
  })

  it('a proposal left writing or testing with no run is listed as failed', async () => {
    const left = (await remote.createProposal(
      {
        sourceKind: 'script',
        sourceKey: 'k',
        sourceSessions: 2,
        projectRoot: root,
        callsBefore: 2
      },
      SIGNAL_NOW
    ))!
    const call = methods()
    // While a run goes, it may still finish.
    let finish: () => void = () => {}
    void runner.start(() => new Promise<void>((resolve) => (finish = resolve)))
    expect((await view(call)).proposals[0]?.state).toBe('writing')
    finish()
    await vi.waitFor(() => expect(runner.running()).toBe(false))
    const swept = { state: 'failed', error: 'Stopped before it finished.', failure: 'error' }
    expect((await view(call)).proposals[0]).toMatchObject({ id: left.id, ...swept })
    expect(await remote.proposal(left.id)).toMatchObject(swept)
  })
})

describe('switching Learn off', () => {
  for (const read of ['codemode.learn.status', 'codemode.learn.list', 'codemode.learn.proposals']) {
    it(`${read} with the switch off aborts the writer request in flight`, async () => {
      await recordSignal(remote, 1, ['s1', 's2'], root)
      await recordSignal(remote, 2, ['s1', 's2'], root)
      let seen: AbortSignal | undefined
      const pending = vi.fn<LearnWriterGenerate>(
        (_prompt, opts) =>
          new Promise((resolve) => {
            seen = opts.signal
            opts.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'canceled' }))
          })
      )
      generate = pending
      const call = methods()
      await call('codemode.learn.propose', {})
      await vi.waitFor(() => expect(seen).toBeDefined())
      expect(seen?.aborted).toBe(false)
      enabled = false
      await call(read)
      expect(seen?.aborted).toBe(true)
      await vi.waitFor(() => expect(runner.running()).toBe(false))
      expect(pending).toHaveBeenCalledOnce()
      expect(await remote.proposals(10)).toMatchObject([
        { state: 'failed', error: LEARN_STOPPED_REASON, failure: 'error' }
      ])
    })
  }
})
