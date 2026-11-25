import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  CodemodeLearnCall,
  CodemodeLearnRun
} from '../../../../shared/codemode/codemode-learn-types'
import { codemodeShapeHash } from '../codemode-shape'
import { inProcessLearnStore, type CodemodeLearnRemote } from './codemode-learn-ops'
import { CodemodeLearnStore } from './codemode-learn-store'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const SCRIPT = `const found = await mcp.crm.find({ q: 'a@b.c' }); return mcp.crm.update(found.id)`
const OTHER = `for (const x of await read({ path: 'a' })) await write({ path: x })`

let dir: string
let path: string
let store: CodemodeLearnStore
let learn: CodemodeLearnRemote

function call(seq: number, patch: Partial<CodemodeLearnCall> = {}): CodemodeLearnCall {
  return {
    seq,
    tool: `mcp.crm.t${seq}`,
    input: { q: seq },
    ok: true,
    output: { n: seq },
    ms: 3,
    ...patch
  }
}

function run(
  runId: string,
  sessionId: string,
  patch: Partial<CodemodeLearnRun> = {}
): CodemodeLearnRun {
  return {
    runId,
    sessionId,
    projectRoot: '/repo',
    startedAt: NOW - 1000,
    ms: 20,
    ok: true,
    code: SCRIPT,
    calls: [call(0), call(1)],
    ...patch
  }
}

function fileBytes(): number {
  return [path, `${path}-wal`].reduce(
    (sum, file) => sum + (existsSync(file) ? statSync(file).size : 0),
    0
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-codemode-learn-'))
  path = join(dir, 'codemode-learn.sqlite')
  store = CodemodeLearnStore.open(path)
  learn = inProcessLearnStore(() => store)
})

afterEach(() => {
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('CodemodeLearnStore', () => {
  it('records a run with its calls', async () => {
    const recorded = run('r1', 's1')
    const result = await learn.record(recorded, NOW)
    expect(result).toEqual({ shape: codemodeShapeHash(SCRIPT), otherSessions: 0, dismissed: false })
    expect(await learn.runsForShape(result.shape, 10)).toEqual([recorded])
    expect(await learn.stats()).toMatchObject({ runs: 1, calls: 2, oldest: NOW - 1000 })
  })

  it('otherSessions counts distinct other sessions, ok runs with ≥2 calls, within 30 days', async () => {
    await learn.record(run('a1', 'a'), NOW)
    await learn.record(run('a2', 'a'), NOW)
    await learn.record(run('b1', 'b'), NOW)
    await learn.record(run('c1', 'c', { ok: false }), NOW)
    await learn.record(run('d1', 'd', { calls: [call(0)] }), NOW)
    await learn.record(run('e1', 'e', { code: OTHER }), NOW)
    await learn.record(run('f1', 'f', { startedAt: NOW - 31 * DAY }), NOW)
    await learn.record(run('g1', 'g', { startedAt: NOW - 29 * DAY }), NOW)
    expect(await learn.record(run('a3', 'a'), NOW)).toMatchObject({ otherSessions: 2 })
    const fresh = await learn.record(run('x1', 'x'), NOW)
    expect(fresh).toMatchObject({ otherSessions: 3, dismissed: false })
    await learn.dismiss(fresh.shape)
    expect(await learn.record(run('x2', 'x'), NOW)).toMatchObject({ dismissed: true })
  })

  it('retention drops runs older than 30 days and keeps at most 5000', async () => {
    await learn.record(run('old', 's', { startedAt: NOW - 31 * DAY }), NOW - 31 * DAY)
    await learn.record(run('new', 's'), NOW)
    // The old run's two call rows went with it.
    expect(await learn.stats()).toMatchObject({ runs: 1, calls: 2, oldest: NOW - 1000 })

    for (let i = 0; i < 5001; i++) {
      store.record(run(`n${i}`, 's', { startedAt: NOW + i, calls: [] }), NOW + i)
    }
    const stats = await learn.stats()
    expect(stats.runs).toBe(5000)
    // The oldest go first: 'new' (and its call rows) and n0 are gone, n1 is the oldest kept.
    expect(stats.oldest).toBe(NOW + 1)
    expect(stats.calls).toBe(0)
  })

  it('caps inputs and outputs', async () => {
    const huge = { text: 'x'.repeat(5 * 1024 * 1024) }
    const longCode = `${SCRIPT}\n// ${'é'.repeat(70 * 1024)}`
    const result = await learn.record(
      run('big', 's', {
        code: longCode,
        calls: [
          call(0, { output: huge }),
          call(1, { input: { q: 'y'.repeat(20 * 1024) } }),
          call(2)
        ]
      }),
      NOW
    )
    const [stored] = await learn.runsForShape(result.shape, 1)
    const [outputCut, inputCut, whole] = stored.calls
    // Each flag names the field that was cut; the other field survived whole.
    expect(outputCut).toMatchObject({ input: { q: 0 }, outputTruncated: true })
    expect(outputCut.inputTruncated).toBeUndefined()
    expect(typeof outputCut.output).toBe('string')
    expect(Buffer.byteLength(String(outputCut.output))).toBeLessThanOrEqual(64 * 1024)
    expect(String(outputCut.output).startsWith('{"text":"xxx')).toBe(true)
    expect(inputCut).toMatchObject({ output: { n: 1 }, inputTruncated: true })
    expect(inputCut.outputTruncated).toBeUndefined()
    expect(Buffer.byteLength(String(inputCut.input))).toBeLessThanOrEqual(16 * 1024)
    expect(whole).toEqual(call(2))
    expect(stored.codeTruncated).toBe(true)
    expect(Buffer.byteLength(stored.code)).toBeLessThanOrEqual(64 * 1024)
    expect(stored.code.includes('�')).toBe(false)
    // The shape is the whole script's, not the cut one's.
    expect(result.shape).toBe(codemodeShapeHash(longCode))
  })

  it('repeatedScripts needs 2 sessions and skips dismissed', async () => {
    await learn.record(run('a1', 'a', { startedAt: NOW - 3000 }), NOW)
    await learn.record(run('a2', 'a', { startedAt: NOW - 2000 }), NOW)
    expect(await learn.repeatedScripts(NOW, 10)).toEqual([])

    const newest = `const found = await mcp.crm.find({ q: 'z@z.z' }); return mcp.crm.update(found.id)`
    await learn.record(run('b1', 'b', { code: newest, projectRoot: '/other' }), NOW)
    for (const session of ['p', 'q', 'r']) {
      await learn.record(run(`o-${session}`, session, { code: OTHER, startedAt: NOW - 5000 }), NOW)
    }
    const shape = codemodeShapeHash(SCRIPT)
    expect(await learn.repeatedScripts(NOW, 10)).toEqual([
      expect.objectContaining({ shape: codemodeShapeHash(OTHER), sessions: 3, runs: 3 }),
      {
        kind: 'script',
        shape,
        sessions: 2,
        runs: 3,
        lastSeen: NOW - 1000,
        sampleCode: newest,
        tools: ['mcp.crm.t0', 'mcp.crm.t1'],
        projectRoots: ['/other', '/repo']
      }
    ])
    expect(await learn.repeatedScripts(NOW, 1)).toHaveLength(1)
    expect(await learn.repeatedScripts(NOW + 31 * DAY, 10)).toEqual([])

    await learn.dismiss(shape)
    await learn.dismiss(shape)
    expect(await learn.dismissed()).toEqual([shape])
    expect((await learn.repeatedScripts(NOW, 10)).map((entry) => entry.shape)).toEqual([
      codemodeShapeHash(OTHER)
    ])
  })

  it('clear empties the store', async () => {
    const bulky = { text: 'b'.repeat(60 * 1024) }
    for (let i = 0; i < 40; i++) {
      await learn.record(
        run(`r${i}`, `s${i}`, { calls: [call(0, { output: bulky }), call(1)] }),
        NOW
      )
    }
    await learn.dismiss('some-shape')
    await learn.saveChains(
      [
        {
          kind: 'chain',
          signature: 'a>b>c',
          tools: ['a', 'b', 'c'],
          sessions: 2,
          occurrences: 2,
          lastSeen: NOW
        }
      ],
      NOW
    )
    const before = fileBytes()
    await learn.clear(NOW)

    expect(await learn.stats()).toMatchObject({ runs: 0, calls: 0, oldest: null })
    expect(await learn.dismissed()).toEqual([])
    expect(await learn.chains()).toEqual({ computedAt: null, chains: [] })
    expect(fileBytes()).toBeLessThan(before / 4)
    // A run that started before the clear and finishes after it is not brought back.
    const late = await learn.record(run('late', 's0', { startedAt: NOW - 1 }), NOW + 1)
    expect(await learn.runsForShape(late.shape, 10)).toEqual([])
    expect(await learn.stats()).toMatchObject({ runs: 0 })
  })

  it('runsForShape newest first', async () => {
    await learn.record(run('first', 'a', { startedAt: NOW - 3000 }), NOW)
    await learn.record(run('third', 'c', { startedAt: NOW - 1000 }), NOW)
    await learn.record(run('second', 'b', { startedAt: NOW - 2000 }), NOW)
    await learn.record(run('elsewhere', 'b', { code: OTHER }), NOW)
    const shape = codemodeShapeHash(SCRIPT)
    expect((await learn.runsForShape(shape, 10)).map((entry) => entry.runId)).toEqual([
      'third',
      'second',
      'first'
    ])
    expect((await learn.runsForShape(shape, 2)).map((entry) => entry.runId)).toEqual([
      'third',
      'second'
    ])
  })

  it('saves and reads back the chain cache', async () => {
    expect(await learn.chains()).toEqual({ computedAt: null, chains: [] })
    const chains = [
      {
        kind: 'chain' as const,
        signature: 'x>y>z',
        tools: ['x', 'y', 'z'],
        sessions: 3,
        occurrences: 4,
        lastSeen: NOW
      },
      {
        kind: 'chain' as const,
        signature: 'a>b>c',
        tools: ['a', 'b', 'c'],
        sessions: 2,
        occurrences: 2,
        lastSeen: NOW - 5
      }
    ]
    await learn.saveChains(chains, NOW)
    expect(await learn.chains()).toEqual({ computedAt: NOW, chains })
    await learn.saveChains([], NOW + 1)
    expect(await learn.chains()).toEqual({ computedAt: NOW + 1, chains: [] })
  })
})
