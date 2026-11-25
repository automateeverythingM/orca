import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRowAttribution,
  type AgentJournalToolCallItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { openTestAgentSessionDatabase } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import {
  readLearnChainSessions,
  refreshChains,
  type LearnChainRecord
} from './codemode-learn-journal-source'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-learn-chains-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function identity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle(`thread-${sessionId}`)
  }
}

function record(sessionId: string, extra: Partial<LearnChainRecord> = {}): LearnChainRecord {
  return {
    sessionId,
    updatedAt: NOW - DAY,
    location: { executionHostId: LOCAL_EXECUTION_HOST_ID },
    ...extra
  }
}

type Call = { name: string; turn: string | null; agentId?: string; mcp?: [string, string] }

/** A chat whose tool calls are written in this order, each in its turn (`null`: thread scope). */
async function chat(sessionId: string, calls: Call[]): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: identity(sessionId),
    stateDirectory: root,
    now: () => NOW - DAY
  })
  let ordinal = 0
  for (const { name, turn, agentId, mcp } of calls) {
    ordinal += 1
    const body: AgentJournalToolCallItem = {
      kind: 'tool-call',
      name,
      input: {},
      state: 'completed',
      ...(mcp ? { mcpIdentity: { server: mcp[0], tool: mcp[1] } } : {})
    }
    const attribution: AgentJournalRowAttribution = {
      turnScope: turn === null ? AGENT_JOURNAL_THREAD_SCOPE : { kind: 'turn', turnItemId: turn },
      ...(agentId ? { agentId } : {})
    }
    await journal.appendItem(
      { provider: 'codex', threadId: `thread-${sessionId}`, turnId: turn ?? 't0', ordinal },
      body,
      { fence: 1, observedAt: NOW - DAY, ...attribution }
    )
  }
  return journal
}

const claudeChain = (turn: string): Call[] => [
  { name: 'mcp__crm__find', turn },
  { name: 'mcp__crm__update', turn },
  { name: 'mcp__mail__send', turn }
]

describe('readLearnChainSessions', () => {
  it('groups top-level calls by turn, marking calls that are not direct', async () => {
    await chat('chat-a', [
      ...claudeChain('turn-1'),
      { name: 'Bash', turn: 'turn-1' },
      { name: 'mcp__orca__run_js', turn: 'turn-1' },
      { name: 'mcp__crm__sub', turn: 'turn-1', agentId: 'sub-1' },
      { name: 'crm/find', turn: 'turn-2', mcp: ['crm', 'find'] },
      { name: 'mcp__crm__thread', turn: null }
    ])
    const readers = (await openTestAgentSessionDatabase(root)).readers
    const sessions = await readLearnChainSessions(
      { records: () => [record('chat-a')], readers },
      NOW
    )
    expect(sessions).toEqual([
      {
        sessionId: 'chat-a',
        turns: [
          { tools: ['crm.find', 'crm.update', 'mail.send', null, null], at: NOW - DAY },
          { tools: ['crm.find'], at: NOW - DAY }
        ]
      }
    ])
  })

  it('reads open and closed chats; skips remote, old and unreadable ones', async () => {
    await chat('chat-open', claudeChain('t'))
    await (await chat('chat-closed', claudeChain('t'))).close()
    await chat('chat-remote', claudeChain('t'))
    await chat('chat-old', claudeChain('t'))
    const readers = (await openTestAgentSessionDatabase(root)).readers
    const sessions = await readLearnChainSessions(
      {
        records: () => [
          record('chat-open'),
          record('chat-closed'),
          record('chat-remote', { location: { executionHostId: 'ssh:box' } }),
          record('chat-old', { updatedAt: NOW - 31 * DAY }),
          record('chat-never-written')
        ],
        readers
      },
      NOW
    )
    expect(sessions.map((session) => session.sessionId).sort()).toEqual([
      'chat-closed',
      'chat-open'
    ])
  })
})

describe('refreshChains', () => {
  it('saves the chains found across chats and returns them', async () => {
    await chat('chat-a', claudeChain('turn-1'))
    await chat('chat-b', claudeChain('turn-9'))
    const readers = (await openTestAgentSessionDatabase(root)).readers
    const saveChains = vi.fn(async () => {})
    const chains = await refreshChains({
      journal: { records: () => [record('chat-a'), record('chat-b')], readers },
      store: { saveChains },
      now: () => NOW
    })
    const expected = [
      {
        kind: 'chain',
        signature: 'crm.find > crm.update > mail.send',
        tools: ['crm.find', 'crm.update', 'mail.send'],
        sessions: 2,
        occurrences: 2,
        lastSeen: NOW - DAY
      }
    ]
    expect(chains).toEqual(expected)
    expect(saveChains).toHaveBeenCalledWith(expected, NOW)
  })
})
