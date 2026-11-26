import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodemodeLearnProposal } from '../../../../../shared/codemode/codemode-learn-types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  fakeGenerate,
  recordSignal
} from '../../../../codemode/learn/testing/learn-signal-fixtures'
import type { LearnWriterGenerate } from '../../../../codemode/learn/writer/codemode-learn-writer'
import { CodemodeLibStore } from '../../../../codemode/lib/codemode-lib-store'
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

  it('an edit that renames both, only @name, or only the function saves under the new name', async () => {
    await new CodemodeLibStore({ projectRoot: null, homeDir: home }).save({
      name: 'plan1',
      source: 'async function plan1() {\n  return 1\n}\n',
      scope: 'global',
      description: 'taken',
      savedBy: 'user'
    })
    const cases: [string, (source: string) => string][] = [
      ['planBoth', (src) => src.replaceAll('plan1', 'planBoth')],
      ['planHeaderOnly', (src) => src.replace('@name plan1', '@name planHeaderOnly')],
      ['planFnOnly', (src) => src.replace('async function plan1(', 'async function planFnOnly(')]
    ]
    for (const [target, edit] of cases) {
      const p = await readyProposal(1, root)
      await expect(
        methods()('codemode.learn.saveProposal', {
          id: p.id,
          scope: 'global',
          source: edit(p.source!)
        })
      ).resolves.toEqual({ name: target, scope: 'global' })
      const saved = readFileSync(join(home, '.orca', 'lib', `${target}.js`), 'utf8')
      expect(saved).toContain(`@name ${target}`)
      expect(saved).toContain(`async function ${target}({ q })`)
      expect(await remote.proposal(p.id)).toMatchObject({
        state: 'saved',
        savedAs: { name: target, scope: 'global' }
      })
    }
    const mismatched = await readyProposal(1, root)
    await expect(
      methods()('codemode.learn.saveProposal', {
        id: mismatched.id,
        scope: 'global',
        source: mismatched
          .source!.replace('@name plan1', '@name planHeader')
          .replace('async function plan1(', 'async function planBody(')
      })
    ).rejects.toThrow('source must define function planHeader')
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
