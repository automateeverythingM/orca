import { describe, expect, it } from 'vitest'
import type { CodemodeRunsEvent } from '../../../shared/codemode/codemode-run-wire'
import { CodemodeRunStore } from './codemode-run-store'

const call = (runId: string, seq: number, state: 'running' | 'ok', output?: string) => ({
  runId,
  seq,
  tool: 'mcp.crm.add_credits',
  input: { note: 'x'.repeat(5000) },
  state,
  ...(state === 'running' ? {} : { ms: 12, output })
})

describe('CodemodeRunStore', () => {
  it('keeps the newest 50 runs per session and cuts what it keeps for display', () => {
    const store = new CodemodeRunStore()
    for (let i = 0; i < 52; i++) {
      store.run('s1', { runId: `r${i}`, code: `return ${i}`, state: 'running' })
    }
    store.run('s2', { runId: 'other', code: 'return 0', state: 'running' })
    const runs = store.runs('s1')
    expect(runs).toHaveLength(50)
    expect(runs[0].runId).toBe('r2')
    expect(runs.at(-1)?.runId).toBe('r51')
    expect(store.runs('s2')).toHaveLength(1)

    store.innerCall('s1', call('r51', 1, 'running'))
    store.innerCall('s1', call('r51', 1, 'ok', 'y'.repeat(20_000)))
    store.innerCall('s1', call('r0', 1, 'running'))
    const [kept] = store.runs('s1').at(-1)?.calls ?? []
    expect(kept.state).toBe('ok')
    expect(Buffer.byteLength(kept.output ?? '')).toBeLessThan(4200)
    expect(Buffer.byteLength(kept.input)).toBeLessThan(1100)
    expect(store.runs('s1').some((run) => run.runId === 'r0')).toBe(false)
  })

  it('keeps 100 calls of a run and counts the rest', () => {
    const store = new CodemodeRunStore()
    store.run('s1', { runId: 'r', code: 'loop', state: 'running' })
    for (let seq = 1; seq <= 103; seq++) {
      store.innerCall('s1', call('r', seq, 'running'))
      store.innerCall('s1', call('r', seq, 'ok', 'done'))
    }
    store.run('s1', { runId: 'r', code: 'loop', state: 'ok', ms: 900 })
    const [run] = store.runs('s1')
    expect(run.calls).toHaveLength(100)
    expect(run.omittedCalls).toBe(3)
    expect(run.state).toBe('ok')
    expect(run.ms).toBe(900)
  })

  it('drops a session at its end and tells its subscribers', () => {
    const store = new CodemodeRunStore()
    store.run('s1', { runId: 'r', code: 'return 1', state: 'running' })
    const seen: CodemodeRunsEvent[] = []
    const unsubscribe = store.subscribe('s1', (event) => seen.push(event))
    expect(seen[0]).toMatchObject({ type: 'snapshot', runs: [{ runId: 'r' }] })

    store.innerCall('s1', call('r', 1, 'running'))
    store.dropSession('s1')
    expect(store.runs('s1')).toEqual([])
    expect(seen.map((event) => event.type)).toEqual(['snapshot', 'call', 'snapshot'])
    expect(seen.at(-1)).toEqual({ type: 'snapshot', sessionId: 's1', runs: [] })

    unsubscribe()
    store.run('s1', { runId: 'r2', code: 'return 2', state: 'running' })
    expect(seen).toHaveLength(3)
  })
})
