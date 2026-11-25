// Retention outside record(), lib-only scripts, the runsForShape cap and compact: a store on a temp file
// with an injected clock.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  CodemodeLearnCall,
  CodemodeLearnRun
} from '../../../../shared/codemode/codemode-learn-types'
import { codemodeShapeHash } from '../codemode-shape'
import { CodemodeLearnStore } from './codemode-learn-store'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const SCRIPT = `const a = await mcp.crm.find({ q: 1 }); return mcp.crm.update(a)`
const LIB_SCRIPT = `const a = await lib.findUser({ q: 1 }); return lib.addCredits(a)`

let dir: string
let path: string
let clock: number
const opened: CodemodeLearnStore[] = []

function open(): CodemodeLearnStore {
  const store = CodemodeLearnStore.open(path, { clock: () => clock })
  opened.push(store)
  return store
}

const call = (seq: number, tool: string): CodemodeLearnCall => ({
  seq,
  tool,
  input: { q: seq },
  ok: true,
  output: { text: 'o'.repeat(4096) },
  ms: 1
})

function run(runId: string, sessionId: string, patch: Partial<CodemodeLearnRun> = {}) {
  return {
    runId,
    sessionId,
    projectRoot: '/repo',
    startedAt: NOW - DAY,
    ms: 5,
    ok: true,
    code: SCRIPT,
    calls: [call(0, 'mcp.crm.find'), call(1, 'mcp.crm.update')],
    ...patch
  } satisfies CodemodeLearnRun
}

const fileBytes = (): number =>
  [path, `${path}-wal`].reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-codemode-learn-retention-'))
  path = join(dir, 'codemode-learn.sqlite')
  clock = NOW
})

afterEach(() => {
  for (const store of opened.splice(0)) {
    store.dispose()
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('CodemodeLearnStore retention without a record', () => {
  it('opening a store holding a 31-day-old run deletes it', () => {
    const first = open()
    first.record(run('r1', 'a'), NOW)
    expect(first.stats().runs).toBe(1)
    first.dispose()
    opened.splice(0)

    clock = NOW + 31 * DAY
    const reopened = open()
    expect(reopened.stats()).toEqual(expect.objectContaining({ runs: 0, calls: 0, oldest: null }))
  })

  it('stats, repeatedScripts and runsForShape drop runs past 30 days', () => {
    const store = open()
    store.record(run('r1', 'a'), NOW)
    store.record(run('r2', 'b'), NOW)
    expect(store.stats()).toMatchObject({ runs: 2, calls: 4 })

    clock = NOW + 30 * DAY
    expect(store.stats()).toMatchObject({ runs: 0, calls: 0, oldest: null })

    clock = NOW
    store.record(run('r3', 'a'), NOW)
    store.record(run('r4', 'b'), NOW)
    expect(store.repeatedScripts(NOW + 31 * DAY, 10)).toEqual([])
    // That read deleted them: they are gone for a read at the old time as well.
    expect(store.runsForShape(codemodeShapeHash(SCRIPT), 10)).toEqual([])

    store.record(run('r5', 'a'), NOW)
    clock = NOW + 31 * DAY
    expect(store.runsForShape(codemodeShapeHash(SCRIPT), 10)).toEqual([])
    clock = NOW
    expect(store.stats().runs).toBe(0)
  })
})

describe('CodemodeLearnStore counted runs', () => {
  it('repeatedScripts leaves out runs that call a saved function', () => {
    const store = open()
    const lib = { code: LIB_SCRIPT, calls: [call(0, 'lib.findUser'), call(1, 'lib.addCredits')] }
    store.record(run('l1', 'a', lib), NOW)
    store.record(run('l2', 'b', lib), NOW)
    // One lib call among MCP calls is enough to leave a run out.
    const mixed = { calls: [call(0, 'mcp.crm.find'), call(1, 'lib.addCredits')] }
    store.record(run('m1', 'a', mixed), NOW)
    expect(store.record(run('m2', 'b', mixed), NOW).otherSessions).toBe(0)
    expect(store.repeatedScripts(NOW, 10)).toEqual([])

    store.record(run('s1', 'a'), NOW)
    store.record(run('s2', 'b'), NOW)
    expect(store.repeatedScripts(NOW, 10)).toEqual([
      expect.objectContaining({
        shape: codemodeShapeHash(SCRIPT),
        sessions: 2,
        runs: 2,
        tools: ['mcp.crm.find', 'mcp.crm.update']
      })
    ])
  })

  it('runsForShape returns at most 20 runs', () => {
    const store = open()
    for (let i = 0; i < 25; i++) {
      store.record(run(`r${i}`, 's', { startedAt: NOW - DAY + i }), NOW)
    }
    const shape = codemodeShapeHash(SCRIPT)
    expect(store.runsForShape(shape, 500)).toHaveLength(20)
    expect(store.runsForShape(shape, Number.NaN)).toHaveLength(20)
    expect(store.runsForShape(shape, 0)).toHaveLength(20)
    expect(store.runsForShape(shape, 2.9).map((entry) => entry.runId)).toEqual(['r24', 'r23'])
  })
})

describe('CodemodeLearnStore clear and compact', () => {
  it('clear only deletes; compact shrinks the file afterwards', () => {
    const store = open()
    for (let i = 0; i < 200; i++) {
      store.record(run(`r${i}`, `s${i}`), NOW)
    }
    store.dismiss('k')
    const before = fileBytes()
    store.clear(NOW)
    // The rows are gone but the file is not shrunk yet: that is compact's slower work.
    expect(fileBytes()).toBeGreaterThan(before / 4)
    expect(store.stats()).toMatchObject({ runs: 0, calls: 0 })
    expect(store.dismissed()).toEqual([])
    store.compact()
    expect(fileBytes()).toBeLessThan(before / 4)
  })
})
