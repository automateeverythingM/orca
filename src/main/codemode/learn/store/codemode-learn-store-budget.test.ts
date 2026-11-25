// The Learn store's byte budgets and list limits, with small injected budgets on a temp file.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  CodemodeLearnCall,
  CodemodeLearnRun
} from '../../../../shared/codemode/codemode-learn-types'
import { codemodeShapeHash } from '../codemode-shape'
import {
  clampLimit,
  LEARN_RUN_CALL_BUDGET_BYTES,
  LEARN_STORE_BUDGET_BYTES
} from './codemode-learn-rows'
import { CodemodeLearnStore, type CodemodeLearnBudgets } from './codemode-learn-store'

const NOW = 1_800_000_000_000
const SCRIPT = `const a = await mcp.crm.find({ q: 1 }); return mcp.crm.update(a)`
const SHAPE = codemodeShapeHash(SCRIPT)

let dir: string
const opened: CodemodeLearnStore[] = []

function open(budgets: Partial<CodemodeLearnBudgets> = {}): CodemodeLearnStore {
  const store = CodemodeLearnStore.open(join(dir, `learn-${opened.length}.sqlite`), {
    ...budgets,
    clock: () => NOW
  })
  opened.push(store)
  return store
}

function call(seq: number, patch: Partial<CodemodeLearnCall> = {}): CodemodeLearnCall {
  return {
    seq,
    tool: 'mcp.crm.find',
    input: { q: seq },
    ok: true,
    output: { n: seq },
    ms: 1,
    ...patch
  }
}

function run(runId: string, startedAt: number, calls: CodemodeLearnCall[]): CodemodeLearnRun {
  return {
    runId,
    sessionId: 's',
    projectRoot: '/repo',
    startedAt,
    ms: 5,
    ok: true,
    code: SCRIPT,
    calls
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-codemode-learn-budget-'))
})

afterEach(() => {
  for (const store of opened.splice(0)) {
    store.dispose()
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('CodemodeLearnStore budgets', () => {
  it('defaults to 2 MiB of call bytes per run and 512 MiB per store', () => {
    expect(LEARN_RUN_CALL_BUDGET_BYTES).toBe(2 * 1024 * 1024)
    expect(LEARN_STORE_BUDGET_BYTES).toBe(512 * 1024 * 1024)
  })

  it('calls past the run budget keep no input or output and are marked truncated', () => {
    const store = open({ runCallBytes: 100 })
    const wide = { q: 'a'.repeat(30) }
    // Each of the first two stores 45 bytes (38 input + 7 output); the third would pass 100.
    const calls = [
      call(0, { input: wide }),
      call(1, { input: wide }),
      call(2, { input: wide }),
      call(3, { output: undefined })
    ]
    store.record(run('r', NOW, calls), NOW)
    const [stored] = store.runsForShape(SHAPE, 1)
    expect(stored.calls.slice(0, 2)).toEqual([call(0, { input: wide }), call(1, { input: wide })])
    for (const dropped of stored.calls.slice(2)) {
      expect(dropped).toMatchObject({ input: null, inputTruncated: true, outputTruncated: true })
      expect(dropped).not.toHaveProperty('output')
    }
    // The rest of each dropped call survives.
    expect(stored.calls.map((entry) => entry.seq)).toEqual([0, 1, 2, 3])
    expect(store.stats().calls).toBe(4)
  })

  it('the store drops its oldest runs once past its byte budget', () => {
    const store = open({ storeBytes: 3000 })
    const bulky = [call(0, { output: 'x'.repeat(1000) })]
    for (let i = 0; i < 5; i++) {
      // About 1,075 stored bytes each: three would pass 3,000.
      store.record(run(`r${i}`, NOW + i, bulky), NOW + i)
    }
    expect(store.runsForShape(SHAPE, 10).map((entry) => entry.runId)).toEqual(['r4', 'r3'])
    expect(store.stats()).toMatchObject({ runs: 2, calls: 2, oldest: NOW + 3 })
  })
})

describe('CodemodeLearnStore list limits', () => {
  it('clamps limits to integers in [1, 500], with 50 for one that is not a number or below 1', () => {
    expect(clampLimit(10_000)).toBe(500)
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(500)
    expect(clampLimit(Number.NaN)).toBe(50)
    expect(clampLimit(-3)).toBe(50)
    expect(clampLimit(0)).toBe(50)
    expect(clampLimit(2.9)).toBe(2)
    const store = open()
    for (let i = 0; i < 30; i++) {
      store.record(run(`r${i}`, NOW + i, []), NOW + i)
    }
    // runsForShape clones every call's input and output, so it returns 20 at most.
    expect(store.runsForShape(SHAPE, 10_000)).toHaveLength(20)
    expect(store.runsForShape(SHAPE, Number.NaN)).toHaveLength(20)
    expect(store.runsForShape(SHAPE, 2.9)).toHaveLength(2)
    expect(store.repeatedScripts(NOW, Number.NaN)).toEqual([])
  })
})
