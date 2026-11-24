import { describe, expect, it } from 'vitest'
import type { CodemodeRunRecord } from '../../../../../shared/codemode/codemode-run-wire'
import { pairCodemodeRuns, type CodemodeWatchedCall } from './codemode-run-pairing'

const SCRIPT = 'return await mcp.crm.add_credits({ amount: 5 })'

const run = (runId: string, state: CodemodeRunRecord['state']): CodemodeRunRecord => ({
  runId,
  code: SCRIPT,
  state,
  startedAt: 0,
  omittedCalls: 0,
  calls: []
})

const call = (callId: string, running: boolean): CodemodeWatchedCall => ({
  callId,
  code: SCRIPT,
  running
})

describe('pairCodemodeRuns', () => {
  it('pairs running runs with running calls oldest first', () => {
    const matches = new Map<string, string>()
    pairCodemodeRuns(
      [run('r1', 'running'), run('r2', 'running')],
      [call('c1', true), call('c2', true)],
      matches
    )
    expect(Object.fromEntries(matches)).toEqual({ c1: 'r1', c2: 'r2' })
  })

  it('pairs settled runs with settled calls newest first', () => {
    const matches = new Map<string, string>()
    pairCodemodeRuns(
      [run('r1', 'ok'), run('r2', 'error')],
      [call('c1', false), call('c2', false)],
      matches
    )
    expect(Object.fromEntries(matches)).toEqual({ c1: 'r1', c2: 'r2' })
  })

  it('pairs a settled run when the calls come as a one-shot iterator', () => {
    const matches = new Map<string, string>()
    const watched = new Map([['c1', call('c1', false)]])
    pairCodemodeRuns([run('r1', 'ok')], watched.values(), matches)
    expect(Object.fromEntries(matches)).toEqual({ c1: 'r1' })
  })

  it('keeps a running run for its own call when only an old settled row has the code', () => {
    const matches = new Map<string, string>()
    const runs = [run('new', 'running')]
    pairCodemodeRuns(runs, [call('old', false)], matches)
    expect(matches.size).toBe(0)

    pairCodemodeRuns(runs, [call('old', false), call('fresh', true)], matches)
    expect(Object.fromEntries(matches)).toEqual({ fresh: 'new' })
  })
})
