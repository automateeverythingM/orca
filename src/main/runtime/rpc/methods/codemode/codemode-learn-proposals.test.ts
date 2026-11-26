import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalsView
} from '../../../../../shared/codemode/codemode-learn-types'
import { CodemodeLearnRunner } from '../../../../codemode/learn/codemode-learn-pipeline'
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
import {
  createLibRecords,
  type CodemodeLibRecords
} from '../../../../codemode/lib/codemode-lib-access'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { requireKnownProject } from './codemode-lib'
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
  const list = codemodeLearnProposalMethods({
    desktop: () => true,
    service: async () => ({
      learnEnabled: () => enabled,
      learnStore: () => remote,
      learnRunner: () => runner,
      libRecords: () => records
    }),
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
    const method = eraseRpcMethods(list).find((m) => m.name === name)
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
          startedAt: SIGNAL_NOW,
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
