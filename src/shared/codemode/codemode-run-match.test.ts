import { describe, expect, it } from 'vitest'
import { isCodemodeRunCall, matchRunToCall } from './codemode-run-match'

const SCRIPT = 'return await mcp.crm.add_credits({ amount: 5 })'

describe('matchRunToCall', () => {
  it('returns the only running run_js call with the same code', () => {
    const session = {
      runningToolCalls: [
        { callId: 'bash-1', name: 'Bash', input: { command: 'ls' } },
        { callId: 'other', name: 'mcp__orca__run_js', input: { code: 'return 1' } },
        { callId: 'toolu_1', name: 'mcp__orca__run_js', input: { code: SCRIPT } }
      ]
    }
    expect(matchRunToCall(session, SCRIPT)).toBe('toolu_1')
  })

  it('returns null when no running run_js call has the code', () => {
    const session = {
      runningToolCalls: [
        { callId: 'a', name: 'mcp__orca__run_js', input: { code: 'return 2' } },
        { callId: 'b', name: 'mcp__crm__run_js', input: { code: SCRIPT } },
        { callId: 'c', name: 'Bash', input: { code: SCRIPT } }
      ]
    }
    expect(matchRunToCall(session, SCRIPT)).toBeNull()
  })

  it('gives two runs of identical code the first call, then the second', () => {
    const runningToolCalls = [
      { callId: 'first', name: 'orca/run_js', input: { code: SCRIPT } },
      { callId: 'second', name: 'orca/run_js', input: { code: SCRIPT } }
    ]
    const first = matchRunToCall({ runningToolCalls }, SCRIPT)
    const second = matchRunToCall(
      { runningToolCalls, matchedCallIds: new Set([first ?? '']) },
      SCRIPT
    )
    expect([first, second]).toEqual(['first', 'second'])
    expect(
      matchRunToCall({ runningToolCalls, matchedCallIds: new Set(['first', 'second']) }, SCRIPT)
    ).toBeNull()
  })
})

describe('isCodemodeRunCall', () => {
  it('knows the Claude and Codex names and an explicit MCP identity', () => {
    expect(isCodemodeRunCall('mcp__orca__run_js')).toBe(true)
    expect(isCodemodeRunCall('orca/run_js')).toBe(true)
    expect(isCodemodeRunCall('run_js', { server: 'orca', tool: 'run_js' })).toBe(true)
    expect(isCodemodeRunCall('mcp__orca__run_js', { server: 'crm', tool: 'run_js' })).toBe(false)
    expect(isCodemodeRunCall('mcp__orca_x__run_js')).toBe(false)
    expect(isCodemodeRunCall('run_js')).toBe(false)
  })
})
