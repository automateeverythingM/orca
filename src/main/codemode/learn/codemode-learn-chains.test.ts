import { describe, expect, it } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { directMcpCall, findRepeatedChains, type ChainSession } from './codemode-learn-chains'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

function call(
  name: string,
  extra: Partial<AgentJournalToolCallItem> = {}
): AgentJournalToolCallItem {
  return { kind: 'tool-call', name, input: {}, state: 'completed', ...extra }
}

const ABC = ['crm.find', 'crm.update', 'mail.send']

function session(sessionId: string, ...turns: ChainSession['turns']): ChainSession {
  return { sessionId, turns }
}

describe('directMcpCall', () => {
  it('reads Claude raw names', () => {
    expect(directMcpCall(call('mcp__fake-crm__find_contact'))).toEqual({
      server: 'fake-crm',
      tool: 'find_contact'
    })
  })

  it('reads the Codex identity', () => {
    expect(
      directMcpCall(call('fake-crm/find', { mcpIdentity: { server: 'fake-crm', tool: 'find' } }))
    ).toEqual({ server: 'fake-crm', tool: 'find' })
  })

  it('excludes run_js and non-MCP tools', () => {
    expect(directMcpCall(call('mcp__orca__run_js'))).toBeNull()
    expect(
      directMcpCall(call('orca/run_js', { mcpIdentity: { server: 'orca', tool: 'run_js' } }))
    ).toBeNull()
    expect(directMcpCall(call('Bash'))).toBeNull()
    expect(directMcpCall(call('fake-crm/find'))).toBeNull()
  })
})

describe('findRepeatedChains', () => {
  it('keeps a chain of 3+ direct calls seen in 2 chats', () => {
    const chains = findRepeatedChains(
      [
        session('a', { tools: ABC, at: NOW - 2 * DAY }, { tools: ABC, at: NOW - DAY }),
        session('b', { tools: ABC, at: NOW - 3 * DAY })
      ],
      NOW
    )
    expect(chains).toEqual([
      {
        kind: 'chain',
        signature: 'crm.find > crm.update > mail.send',
        tools: ABC,
        sessions: 2,
        occurrences: 3,
        lastSeen: NOW - DAY
      }
    ])
  })

  it('needs 2 distinct chats', () => {
    expect(
      findRepeatedChains([session('a', { tools: ABC, at: NOW }, { tools: ABC, at: NOW })], NOW)
    ).toEqual([])
  })

  it('ignores runs shorter than 3', () => {
    const two = ['crm.find', 'crm.update']
    expect(
      findRepeatedChains(
        [session('a', { tools: two, at: NOW }), session('b', { tools: two, at: NOW })],
        NOW
      )
    ).toEqual([])
  })

  it('a call that is not direct breaks the chain', () => {
    const broken = ['crm.find', null, 'crm.update', 'mail.send']
    expect(
      findRepeatedChains(
        [session('a', { tools: broken, at: NOW }), session('b', { tools: broken, at: NOW })],
        NOW
      )
    ).toEqual([])
  })

  it('a chain is the maximal run, not its parts', () => {
    const four = [...ABC, 'crm.close']
    const chains = findRepeatedChains(
      [session('a', { tools: four, at: NOW }), session('b', { tools: ABC, at: NOW })],
      NOW
    )
    expect(chains).toEqual([])
  })

  it('turns are boundaries', () => {
    expect(
      findRepeatedChains(
        [
          session('a', { tools: ABC.slice(0, 2), at: NOW }, { tools: ABC.slice(2), at: NOW }),
          session('b', { tools: ABC.slice(0, 2), at: NOW }, { tools: ABC.slice(2), at: NOW })
        ],
        NOW
      )
    ).toEqual([])
  })

  it('ignores turns older than 30 days', () => {
    expect(
      findRepeatedChains(
        [session('a', { tools: ABC, at: NOW }), session('b', { tools: ABC, at: NOW - 31 * DAY })],
        NOW
      )
    ).toEqual([])
  })

  it('orders by chats, then occurrences, then recency', () => {
    const xyz = ['x.a', 'x.b', 'x.c']
    const chains = findRepeatedChains(
      [
        session('a', { tools: xyz, at: NOW - DAY }, { tools: ABC, at: NOW - 5 * DAY }),
        session('b', { tools: xyz, at: NOW - DAY }, { tools: ABC, at: NOW - 5 * DAY }),
        session('c', { tools: ABC, at: NOW - 5 * DAY })
      ],
      NOW
    )
    expect(chains.map((chain) => chain.signature)).toEqual([
      'crm.find > crm.update > mail.send',
      'x.a > x.b > x.c'
    ])
  })
})
