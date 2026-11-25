import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodemodeLearnCall } from '../../../shared/codemode/codemode-learn-types'
import type { CodemodeRunsEvent } from '../../../shared/codemode/codemode-run-wire'
import { CodemodeRunStore } from '../runs/codemode-run-store'
import { CodemodeLearnRecorder, learnNote, learnSessionHooks } from './codemode-learn-recorder'
import { fakeLearnStore, type Recorded } from './testing/fake-learn-store'

const call = (seq: number, tool = 'mcp.crm.find_user'): CodemodeLearnCall => ({
  seq,
  tool,
  input: { email: 'x@y.com' },
  ok: true,
  output: 'out',
  ms: 3
})

function makeRecorder(opts: {
  enabled?: () => boolean
  record?: (run: unknown, now: number) => Promise<Recorded>
}) {
  const store = fakeLearnStore(
    opts.record ?? (async () => ({ shape: 'h', otherSessions: 0, dismissed: false }))
  )
  const storeFactory = vi.fn(() => store)
  const log = vi.fn()
  const recorder = new CodemodeLearnRecorder({
    enabled: opts.enabled ?? (() => true),
    store: storeFactory,
    log
  })
  const feed = (runId: string, tools: string[]): void => {
    recorder.begin('s1', '/project', runId, 'code')
    tools.forEach((tool, index) => recorder.call(runId, call(index + 1, tool)))
  }
  return { recorder, store, storeFactory, log, feed }
}

const finished = { ok: true, ms: 40, startedAt: 1000 }

afterEach(() => {
  vi.useRealTimers()
})

describe('CodemodeLearnRecorder', () => {
  it('switch off records nothing', async () => {
    let on = false
    const h = makeRecorder({ enabled: () => on })
    h.feed('r1', ['mcp.crm.a', 'mcp.crm.b'])
    expect(await h.recorder.finish('r1', finished)).toEqual({ note: null, seenInChats: null })
    expect(h.storeFactory).not.toHaveBeenCalled()
    expect(h.store.record).not.toHaveBeenCalled()

    // Read per run: the next run sees the switch as it is now.
    on = true
    h.feed('r2', ['mcp.crm.a', 'mcp.crm.b'])
    await h.recorder.finish('r2', finished)
    expect(h.store.record).toHaveBeenCalledTimes(1)
    expect(h.store.record.mock.calls[0][0]).toMatchObject({
      runId: 'r2',
      sessionId: 's1',
      projectRoot: '/project',
      code: 'code',
      ok: true,
      ms: 40,
      startedAt: 1000,
      calls: [call(1, 'mcp.crm.a'), call(2, 'mcp.crm.b')]
    })
  })

  it('nudge after a shape seen in another chat', async () => {
    const h = makeRecorder({
      record: async () => ({ shape: 'h', otherSessions: 2, dismissed: false })
    })
    h.feed('r1', ['mcp.crm.a', 'orca.worktree.list'])
    expect(await h.recorder.finish('r1', finished)).toEqual({
      note: learnNote(2),
      seenInChats: 3
    })
    expect(learnNote(1)).toBe(
      '\nNote: you have run this same script in 1 other chat(s). If the person may want it again, offer to save it as a function with lib.save.'
    )
  })

  it('nudges once per chat and shape; seenInChats marks every run', async () => {
    const h = makeRecorder({
      record: async () => ({ shape: 'h', otherSessions: 1, dismissed: false })
    })
    const results: Awaited<ReturnType<typeof h.recorder.finish>>[] = []
    for (const runId of ['r1', 'r2', 'r3']) {
      h.feed(runId, ['mcp.crm.a', 'mcp.crm.b'])
      results.push(await h.recorder.finish(runId, finished))
    }
    expect(results).toEqual([
      { note: learnNote(1), seenInChats: 2 },
      { note: null, seenInChats: 2 },
      { note: null, seenInChats: 2 }
    ])
    // Another chat running the same shape still gets its own nudge.
    h.recorder.begin('s2', '/project', 'r4', 'code')
    h.recorder.call('r4', call(1, 'mcp.crm.a'))
    h.recorder.call('r4', call(2, 'mcp.crm.b'))
    expect(await h.recorder.finish('r4', finished)).toEqual({ note: learnNote(1), seenInChats: 2 })
  })

  it('a run in flight is not recorded once Learn is off or its store is closed for deletion', async () => {
    let enabled = true
    const h = makeRecorder({ enabled: () => enabled })
    h.feed('r1', ['mcp.crm.a', 'mcp.crm.b'])
    enabled = false
    expect(await h.recorder.finish('r1', finished)).toEqual({ note: null, seenInChats: null })

    enabled = true
    h.feed('r2', ['mcp.crm.a', 'mcp.crm.b'])
    h.recorder.dropPending()
    expect(await h.recorder.finish('r2', finished)).toEqual({ note: null, seenInChats: null })
    expect(h.store.record).not.toHaveBeenCalled()
    expect(h.storeFactory).not.toHaveBeenCalled()
  })

  it('no nudge for lib calls or trivial scripts', async () => {
    const h = makeRecorder({
      record: async () => ({ shape: 'h', otherSessions: 4, dismissed: false })
    })
    const none = { note: null, seenInChats: null }
    h.feed('lib', ['mcp.crm.a', 'lib.addCredits'])
    expect(await h.recorder.finish('lib', finished)).toEqual(none)
    h.feed('one', ['mcp.crm.a'])
    expect(await h.recorder.finish('one', finished)).toEqual(none)
    h.feed('failed', ['mcp.crm.a', 'mcp.crm.b'])
    expect(await h.recorder.finish('failed', { ...finished, ok: false })).toEqual(none)
    // Still recorded: Learn lists them, only the nudge is skipped.
    expect(h.store.record).toHaveBeenCalledTimes(3)

    const dismissed = makeRecorder({
      record: async () => ({ shape: 'h', otherSessions: 4, dismissed: true })
    })
    dismissed.feed('r', ['mcp.crm.a', 'mcp.crm.b'])
    expect(await dismissed.recorder.finish('r', finished)).toEqual(none)
    const firstTime = makeRecorder({})
    firstTime.feed('r', ['mcp.crm.a', 'mcp.crm.b'])
    expect(await firstTime.recorder.finish('r', finished)).toEqual(none)
  })

  it('worker failure or slow worker never fails the run', async () => {
    vi.useFakeTimers()
    let mode: 'reject' | 'hang' = 'hang'
    const h = makeRecorder({
      record: () =>
        mode === 'reject' ? Promise.reject(new Error('worker died')) : new Promise(() => {})
    })
    const slow = async (runId: string): Promise<void> => {
      h.feed(runId, ['mcp.crm.a', 'mcp.crm.b'])
      let settled: unknown = 'pending'
      void h.recorder.finish(runId, finished).then((result) => (settled = result))
      await vi.advanceTimersByTimeAsync(1999)
      expect(settled).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toEqual({ note: null, seenInChats: null })
    }
    await slow('r1')
    expect(h.log).toHaveBeenCalledTimes(1)
    expect(h.log.mock.calls[0][0]).toContain('did not answer within 2000ms')

    // A timeout does not use up the failure log: a later real failure is still logged, once.
    mode = 'reject'
    h.feed('r2', ['mcp.crm.a', 'mcp.crm.b'])
    expect(await h.recorder.finish('r2', finished)).toEqual({ note: null, seenInChats: null })
    expect(h.log).toHaveBeenCalledTimes(2)
    expect(h.log.mock.calls[1][1]).toEqual(new Error('worker died'))
    h.feed('r3', ['mcp.crm.a', 'mcp.crm.b'])
    await h.recorder.finish('r3', finished)
    mode = 'hang'
    await slow('r4')
    expect(h.log).toHaveBeenCalledTimes(2)

    // A run the nudge can't apply to never waits on the worker at all.
    h.feed('r5', ['mcp.crm.a'])
    expect(await h.recorder.finish('r5', finished)).toEqual({ note: null, seenInChats: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cuts each call as it arrives and applies the per-run budget', async () => {
    const h = makeRecorder({})
    h.recorder.begin('s1', '/project', 'r', 'code')
    const reply = 'y'.repeat(100 * 1024)
    for (let seq = 1; seq <= 40; seq++) {
      h.recorder.call('r', { ...call(seq), input: { note: 'z'.repeat(20 * 1024) }, output: reply })
    }
    h.recorder.call('r', { ...call(41), ok: false, output: undefined, error: 'boom' })
    await h.recorder.finish('r', finished)
    const [run] = h.store.record.mock.calls[0]
    const [first] = run.calls
    expect(first.inputTruncated).toBe(true)
    expect(first.outputTruncated).toBe(true)
    expect(Buffer.byteLength(String(first.input))).toBeLessThanOrEqual(16 * 1024)
    expect(Buffer.byteLength(String(first.output))).toBeLessThanOrEqual(64 * 1024)
    expect(String(first.output).startsWith('"yyy')).toBe(true)
    // 16 + 64 KiB a call: 25 calls fit 2 MiB; the 26th and every later one keep nothing.
    const kept = run.calls.filter((entry) => entry.input !== null)
    expect(kept).toHaveLength(25)
    for (const dropped of run.calls.slice(25)) {
      expect(dropped).toMatchObject({ input: null, inputTruncated: true, outputTruncated: true })
      expect(dropped).not.toHaveProperty('output')
    }
    expect(run.calls.at(-1)).toMatchObject({ seq: 41, ok: false, error: 'boom' })
    // A small call keeps its values as they were, unmarked.
    const small = makeRecorder({})
    small.feed('s', ['mcp.crm.a'])
    await small.recorder.finish('s', finished)
    expect(small.store.record.mock.calls[0][0].calls).toEqual([call(1, 'mcp.crm.a')])
  })

  it('a call after finish or for an unknown run is ignored', async () => {
    const h = makeRecorder({})
    h.recorder.call('nope', call(1))
    expect(await h.recorder.finish('nope', finished)).toEqual({ note: null, seenInChats: null })
    h.feed('r', ['mcp.crm.a'])
    await h.recorder.finish('r', finished)
    h.recorder.call('r', call(2))
    expect(h.store.record.mock.calls[0][0].calls).toHaveLength(1)
  })

  it('seenInChats annotates the run record', async () => {
    const runs = new CodemodeRunStore(() => 1000)
    const h = makeRecorder({
      record: async () => ({ shape: 'h', otherSessions: 1, dismissed: false })
    })
    const hooks = learnSessionHooks(h.recorder, {
      sessionId: 's1',
      projectRoot: '/project',
      annotate: (runId, patch) => runs.annotate('s1', runId, patch)
    })
    const seen: CodemodeRunsEvent[] = []
    runs.subscribe('s1', (event) => seen.push(event))
    runs.run('s1', { runId: 'r', code: 'code', state: 'running' })
    hooks.begin('r', 'code')
    hooks.onCall('r', call(1))
    hooks.onCall('r', call(2))
    expect(await hooks.onFinish({ runId: 'r', ...finished })).toBe(learnNote(1))
    expect(runs.runs('s1')[0].seenInChats).toBe(2)
    expect(seen.at(-1)).toMatchObject({ type: 'run', run: { runId: 'r', seenInChats: 2 } })

    // No repeat: no annotation.
    const plain = makeRecorder({})
    const plainHooks = learnSessionHooks(plain.recorder, {
      sessionId: 's1',
      projectRoot: '/project',
      annotate: (runId, patch) => runs.annotate('s1', runId, patch)
    })
    runs.run('s1', { runId: 'r2', code: 'code', state: 'running' })
    plainHooks.begin('r2', 'code')
    expect(await plainHooks.onFinish({ runId: 'r2', ...finished })).toBeNull()
    expect(runs.runs('s1')[1].seenInChats).toBeUndefined()
  })
})
