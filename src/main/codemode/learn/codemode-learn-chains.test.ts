import { describe, expect, it } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  chainCallKey,
  chainToolKey,
  directMcpCall,
  findRepeatedChains,
  LEARN_MAX_CHAINS,
  type ChainSession
} from './codemode-learn-chains'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

function call(
  name: string,
  extra: Partial<AgentJournalToolCallItem> = {}
): AgentJournalToolCallItem {
  return { kind: 'tool-call', name, input: {}, state: 'completed', ...extra }
}

/** `server.tool` display text to the call key a turn carries. */
const k = (display: string) => chainCallKey(display.split('.')[0], display.split('.')[1])
const keys = (...displays: string[]) => displays.map(k)
const ABC_DISPLAY = ['crm.find', 'crm.update', 'mail.send']
const ABC = keys(...ABC_DISPLAY)
const ABC_SIGNATURE = 'crm\u001ffind\u001ecrm\u001fupdate\u001email\u001fsend'

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
        signature: ABC_SIGNATURE,
        tools: ABC_DISPLAY,
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
    const two = keys('crm.find', 'crm.update')
    expect(
      findRepeatedChains(
        [session('a', { tools: two, at: NOW }), session('b', { tools: two, at: NOW })],
        NOW
      )
    ).toEqual([])
  })

  it('a call that is not direct breaks the chain', () => {
    const broken = [k('crm.find'), null, k('crm.update'), k('mail.send')]
    expect(
      findRepeatedChains(
        [session('a', { tools: broken, at: NOW }), session('b', { tools: broken, at: NOW })],
        NOW
      )
    ).toEqual([])
  })

  it('a chain is the maximal run, not its parts', () => {
    const four = [...ABC, k('crm.close')]
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
    const xyz = keys('x.a', 'x.b', 'x.c')
    const chains = findRepeatedChains(
      [
        session('a', { tools: xyz, at: NOW - DAY }, { tools: ABC, at: NOW - 5 * DAY }),
        session('b', { tools: xyz, at: NOW - DAY }, { tools: ABC, at: NOW - 5 * DAY }),
        session('c', { tools: ABC, at: NOW - 5 * DAY })
      ],
      NOW
    )
    expect(chains.map((chain) => chain.tools.join(' > '))).toEqual([
      'crm.find > crm.update > mail.send',
      'x.a > x.b > x.c'
    ])
  })

  it('leaves out dismissed chains before the cap', () => {
    const many = Array.from({ length: LEARN_MAX_CHAINS }, (_, index) =>
      keys(`s${index}.a`, `s${index}.b`, `s${index}.c`)
    )
    const sessions = ['a', 'b'].map((id) =>
      session(id, ...many.map((tools) => ({ tools, at: NOW })))
    )
    // The dismissed chain ranks first (3 chats), so a cut before the filter would keep only 99.
    sessions.push(session('c', { tools: ABC, at: NOW }))
    sessions[0].turns = [...sessions[0].turns, { tools: ABC, at: NOW }]
    sessions[1].turns = [...sessions[1].turns, { tools: ABC, at: NOW }]
    const chains = findRepeatedChains(sessions, NOW, new Set([ABC_SIGNATURE]))
    expect(chains).toHaveLength(LEARN_MAX_CHAINS)
    expect(chains.map((chain) => chain.signature)).not.toContain(ABC_SIGNATURE)
  })
})

describe('chain keys', () => {
  it('server a.b with tool c is not server a with tool b.c', () => {
    const left = chainToolKey(call('mcp__a.b__c'))
    const right = chainToolKey(call('x', { mcpIdentity: { server: 'a', tool: 'b.c' } }))
    expect(left).not.toBeNull()
    expect(left).not.toEqual(right)
    const tail = keys('d.e', 'f.g')
    expect(
      findRepeatedChains(
        [
          session('a', { tools: [left, ...tail], at: NOW }),
          session('b', { tools: [right, ...tail], at: NOW })
        ],
        NOW
      )
    ).toEqual([])
  })

  it('a name holding a key separator is not a direct call', () => {
    expect(directMcpCall(call('x', { mcpIdentity: { server: 'a\u001fb', tool: 'c' } }))).toBeNull()
  })
})
