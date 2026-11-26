import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CodemodeLearnProposal } from '../../../../shared/codemode/codemode-learn-types'
import { inProcessLearnStore, type CodemodeLearnRemote } from './codemode-learn-ops'
import { CodemodeLearnStore } from './codemode-learn-store'

const NOW = 1_800_000_000_000
let dir: string
let path: string
let store: CodemodeLearnStore
let learn: CodemodeLearnRemote

const base = (key: string) => ({
  sourceKind: 'script' as const,
  sourceKey: key,
  sourceSessions: 3,
  projectRoot: '/repo',
  callsBefore: 4
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learn-proposals-'))
  path = join(dir, 'learn.db')
  store = CodemodeLearnStore.open(path, { clock: () => NOW })
  learn = inProcessLearnStore(() => store)
})
afterEach(() => {
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('Learn proposals', () => {
  it('create then update moves through states', async () => {
    const made = await learn.createProposal(base('s1'), NOW)
    expect(made).toMatchObject({ state: 'writing', createdAt: NOW, sourceKey: 's1' })
    const id = made!.id
    expect(await learn.updateProposal(id, { state: 'testing', name: 'f' }, ['writing'])).toBe(true)
    expect(
      await learn.updateProposal(id, { state: 'ready', testStatus: 'passed' }, ['testing'])
    ).toBe(true)
    expect(await learn.proposal(id)).toMatchObject({
      state: 'ready',
      name: 'f',
      testStatus: 'passed',
      callsBefore: 4
    })
    expect(await learn.proposal('nope')).toBeNull()
  })

  it('updateProposal refuses when the state moved on', async () => {
    const id = (await learn.createProposal(base('s1'), NOW))!.id
    await learn.updateProposal(id, { state: 'dismissed' }, ['writing', 'testing', 'ready'])
    expect(await learn.updateProposal(id, { state: 'ready', name: 'late' }, ['testing'])).toBe(
      false
    )
    expect(await learn.proposal(id)).toMatchObject({ state: 'dismissed' })
    expect((await learn.proposal(id))?.name).toBeUndefined()
  })

  it('lists newest first', async () => {
    await learn.createProposal(base('a'), NOW)
    await learn.createProposal(base('b'), NOW + 5)
    expect((await learn.proposals(10)).map((p) => p.sourceKey)).toEqual(['b', 'a'])
  })

  it('retention keeps 50 and never drops saved', async () => {
    const saved: CodemodeLearnProposal[] = []
    for (let i = 0; i < 3; i++) {
      const p = (await learn.createProposal(base(`saved${i}`), NOW + i))!
      await learn.updateProposal(p.id, { state: 'saved' }, ['writing'])
      saved.push(p)
    }
    const dismissed = (await learn.createProposal(base('d'), NOW + 10))!
    await learn.updateProposal(dismissed.id, { state: 'dismissed' }, ['writing'])
    for (let i = 0; i < 60; i++) {
      const p = (await learn.createProposal(base(`r${i}`), NOW + 100 + i))!
      await learn.updateProposal(p.id, { state: 'ready' }, ['writing'])
    }
    const all = await learn.proposals(500)
    expect(all).toHaveLength(50)
    for (const p of saved) {
      expect(all.some((x) => x.id === p.id)).toBe(true)
    }
    expect(all.some((x) => x.id === dismissed.id)).toBe(false)
    // oldest ready went first; newest ready stays
    expect(all.some((x) => x.sourceKey === 'r0')).toBe(false)
    expect(all.some((x) => x.sourceKey === 'r59')).toBe(true)
  })

  it('clear deletes proposals and refuses one from a run that started before it', async () => {
    await learn.createProposal(base('s1'), NOW)
    await learn.clear(NOW + 10)
    expect(await learn.proposals(10)).toEqual([])
    expect(await learn.createProposal(base('late'), NOW + 5)).toBeNull()
    expect(await learn.proposals(10)).toEqual([])
    expect(await learn.createProposal(base('ok'), NOW + 10)).not.toBeNull()
  })

  it('openProposalKeys lists live and saved sources only', async () => {
    const w = (await learn.createProposal(base('writing'), NOW))!
    const f = (await learn.createProposal(base('failed'), NOW))!
    const d = (await learn.createProposal(base('dismissed'), NOW))!
    const s = (await learn.createProposal(base('saved'), NOW))!
    await learn.updateProposal(f.id, { state: 'failed' }, ['writing'])
    await learn.updateProposal(d.id, { state: 'dismissed' }, ['writing'])
    await learn.updateProposal(s.id, { state: 'saved' }, ['writing'])
    expect(w.state).toBe('writing')
    expect(await learn.openProposalKeys()).toEqual(['saved', 'writing'])
  })

  it('caps testLog at 16 KiB and source at 256 KiB, and keeps an old file working', async () => {
    const id = (await learn.createProposal(base('s1'), NOW))!.id
    await learn.updateProposal(
      id,
      { testLog: 'x'.repeat(40_000), source: 'y'.repeat(300_000), params: [{ name: 'a' }] },
      ['writing']
    )
    const p = (await learn.proposal(id))!
    expect(p.testLog).toHaveLength(16 * 1024)
    expect(p.source).toHaveLength(256 * 1024)
    expect(p.params).toEqual([{ name: 'a' }])
    store.dispose()
    store = CodemodeLearnStore.open(path, { clock: () => NOW })
    expect((await inProcessLearnStore(() => store).proposal(id))?.state).toBe('writing')
  })
})

describe('Learn proposal updates (one conditional statement)', () => {
  it('keeps sourceKey, id and createdAt whatever the patch says', async () => {
    const made = (await learn.createProposal(base('s1'), NOW))!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a patch from outside the type, as the worker boundary allows.
    const patch = { sourceKey: 'other', id: 'x', createdAt: 1, name: 'f' } as never
    expect(await learn.updateProposal(made.id, patch, ['writing'])).toBe(true)
    expect(await learn.proposal(made.id)).toMatchObject({
      id: made.id,
      sourceKey: 's1',
      createdAt: NOW,
      state: 'writing',
      name: 'f'
    })
    expect(await learn.openProposalKeys()).toEqual(['s1'])
  })

  it('replaces a field whole and keeps the others', async () => {
    const id = (await learn.createProposal(base('s1'), NOW))!.id
    await learn.updateProposal(id, { sampleArgs: { a: 1 }, expect: ['x', 'y'] }, ['writing'])
    await learn.updateProposal(id, { state: 'testing', sampleArgs: { b: 2 }, expect: ['z'] }, [
      'writing'
    ])
    expect(await learn.proposal(id)).toMatchObject({
      state: 'testing',
      sampleArgs: { b: 2 },
      expect: ['z'],
      callsBefore: 4
    })
    expect((await learn.proposal(id))?.sampleArgs).toEqual({ b: 2 })
  })

  it('refuses an unknown id and an empty onlyFrom', async () => {
    const id = (await learn.createProposal(base('s1'), NOW))!.id
    expect(await learn.updateProposal('nope', { state: 'ready' }, ['writing'])).toBe(false)
    expect(await learn.updateProposal(id, { state: 'ready' }, [])).toBe(false)
    expect((await learn.proposal(id))?.state).toBe('writing')
  })
})

describe('Learn run lookups for proposals', () => {
  const run = (runId: string, sessionId: string, code: string, tools: string[]) => ({
    runId,
    sessionId,
    projectRoot: '/repo',
    startedAt: NOW - 1000,
    ms: 5,
    ok: true,
    code,
    calls: tools.map((tool, seq) => ({ seq, tool, input: {}, ok: true, ms: 1 }))
  })

  it('sessionShapes lists the shapes one chat ran', async () => {
    const a = await learn.record(run('r1', 's1', 'return mcp.a.x()', ['mcp.a.x', 'mcp.a.y']), NOW)
    const b = await learn.record(run('r2', 's1', 'return mcp.b.x()', ['mcp.b.x']), NOW)
    await learn.record(run('r3', 's2', 'return mcp.c.x()', ['mcp.c.x']), NOW)
    expect((await learn.sessionShapes('s1')).sort()).toEqual([a.shape, b.shape].sort())
    expect(await learn.sessionShapes('nobody')).toEqual([])
  })

  it('libCallsAfter averages the calls of runs that called lib.<name>', async () => {
    const since = NOW - 1000
    expect(await learn.libCallsAfter('plan', since, null)).toBeNull()
    await learn.record(run('r1', 's1', 'return lib.plan()', ['lib.plan', 'mcp.a.x']), NOW)
    await learn.record(run('r2', 's2', 'return lib.plan({})', ['lib.plan', 'mcp.a.x', 'x']), NOW)
    await learn.record(run('r3', 's2', 'return lib.planner()', ['lib.planner']), NOW)
    expect(await learn.libCallsAfter('plan', since, null)).toBe(2.5)
    expect(await learn.libCallsAfter('planner', since, null)).toBe(1)
    // Only runs in the function's project, started once it was saved.
    await learn.record(
      { ...run('r4', 's3', 'return lib.plan(1)', ['lib.plan']), projectRoot: '/other' },
      NOW
    )
    expect(await learn.libCallsAfter('plan', since, '/repo')).toBe(2.5)
    expect(await learn.libCallsAfter('plan', since, '/other')).toBe(1)
    expect(await learn.libCallsAfter('plan', since, null)).toBe(2)
    expect(await learn.libCallsAfter('plan', since + 1, null)).toBeNull()
  })
})
