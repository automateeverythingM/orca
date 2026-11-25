import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { createClaudeJournalTranslator } from '../../claude/structured/journal/claude-structured-journal-translation'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import {
  writeToolCallChat,
  type FixtureToolCall
} from '../../native-chat/agent-session-journal/journal-tool-call-chat.test-fixture'
import { openTestAgentSessionDatabase } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { chainCallKey } from './codemode-learn-chains'
import {
  readLearnChainSessions,
  refreshChains,
  type LearnChainJournal,
  type LearnChainRecord,
  type RefreshChainsDeps
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

function record(sessionId: string, extra: Partial<LearnChainRecord> = {}): LearnChainRecord {
  return {
    sessionId,
    updatedAt: NOW - DAY,
    location: { executionHostId: LOCAL_EXECUTION_HOST_ID },
    ...extra
  }
}

const chat = (sessionId: string, calls: FixtureToolCall[]) =>
  writeToolCallChat(journals, root, sessionId, calls, NOW - DAY)

const claudeChain = (turn: string): FixtureToolCall[] => [
  { name: 'mcp__crm__find', turn },
  { name: 'mcp__crm__update', turn },
  { name: 'mcp__mail__send', turn }
]

const CHAIN_KEYS = [
  chainCallKey('crm', 'find'),
  chainCallKey('crm', 'update'),
  chainCallKey('mail', 'send')
]

async function journalOf(...records: LearnChainRecord[]): Promise<LearnChainJournal> {
  return { records: () => records, readers: (await openTestAgentSessionDatabase(root)).readers }
}

function deps(journal: LearnChainJournal, dismissed: string[] = []) {
  return {
    journal,
    store: { saveChains: vi.fn(async () => {}), dismissed: vi.fn(async () => dismissed) },
    now: () => NOW,
    log: vi.fn()
  } satisfies RefreshChainsDeps
}

type ClaudeRow = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: StructuredAgentSessionItemAppendOptions
}

/** One Claude turn that calls `tools` one after another, each answered, as Claude's structured
 *  translation journals it: the rows it hands its sink, written to a journal in that order. */
async function claudeChat(sessionId: string, tools: string[]) {
  const rows: ClaudeRow[] = []
  const append = (
    ...[identity, body, options]: Parameters<StructuredAgentSessionEventSink['appendItem']>
  ) => {
    rows.push({ identity, body, options })
    return true
  }
  const sink = {
    appendItem: append,
    tryAppendItem: append,
    publish: () => true,
    tryPublish: () => true,
    appendLifecycleBatch: () => true,
    tryAppendLifecycleBatch: () => true,
    tryAppendLifecycleTransition: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a turn of plain tool calls reaches only these sink methods; a missing one throws and fails the test.
  const translatorSink = sink as unknown as StructuredAgentSessionEventSink
  const translator = createClaudeJournalTranslator({ sink: translatorSink })
  const frame = (message: Record<string, unknown>) =>
    translator.handle({ type: 'message', sessionId, observedAt: NOW - DAY, message })
  tools.forEach((name, index) => {
    const id = `toolu_${index}`
    frame({
      type: 'assistant',
      session_id: `claude-${sessionId}`,
      uuid: `a-${index}`,
      message: {
        id: `msg_${index}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input: {} }]
      }
    })
    frame({
      type: 'user',
      session_id: `claude-${sessionId}`,
      uuid: `u-${index}`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }
    })
  })
  const journal = await journals.open({
    identity: {
      sessionId,
      workspaceId: 'ws-1',
      hostId: 'host-1',
      agent: 'claude',
      providerHandle: claudeProviderHandle(`claude-${sessionId}`, null)
    },
    stateDirectory: root,
    now: () => NOW - DAY
  })
  for (const { identity, body, options } of rows) {
    await journal.appendItem(identity, body, {
      fence: 1,
      observedAt: NOW - DAY,
      turnScope: options.turnScope,
      ...(options.agentId ? { agentId: options.agentId } : {})
    })
  }
  // A call's result row revises its call row (same identity): one call each.
  const calls = new Map(
    rows
      .filter((row) => row.body.kind === 'tool-call')
      .map((row) => [JSON.stringify(row.identity), row])
  )
  return [...calls.values()]
}

describe('readLearnChainSessions', () => {
  it('Claude MCP calls in one turn, as Claude journals them, form a chain', async () => {
    const tools = ['mcp__crm__find', 'mcp__crm__update', 'mcp__mail__send']
    const written = await claudeChat('claude-a', tools)
    await claudeChat('claude-b', tools)
    // Claude names the call `mcp__server__tool`, states no MCP identity, and scopes it to the turn.
    expect(new Set(written.map((row) => JSON.stringify(row.options.turnScope))).size).toBe(1)
    expect(written[0].options.turnScope).toMatchObject({ kind: 'turn' })
    expect(written.map((row) => row.body.kind === 'tool-call' && row.body.mcpIdentity)).toEqual([
      undefined,
      undefined,
      undefined
    ])
    const sessions = await readLearnChainSessions(
      await journalOf(record('claude-a'), record('claude-b')),
      NOW,
      vi.fn()
    )
    expect(sessions.map((entry) => entry.turns.map((turn) => turn.tools))).toEqual([
      [CHAIN_KEYS],
      [CHAIN_KEYS]
    ])
    const refresh = deps(await journalOf(record('claude-a'), record('claude-b')))
    expect(await refreshChains(refresh)).toEqual([
      expect.objectContaining({ tools: ['crm.find', 'crm.update', 'mail.send'], sessions: 2 })
    ])
  })

  it('groups top-level calls by turn, marking calls that are not direct', async () => {
    await chat('chat-a', [
      ...claudeChain('turn-1'),
      { name: 'Bash', turn: 'turn-1' },
      { name: 'mcp__orca__run_js', turn: 'turn-1' },
      { name: 'mcp__crm__sub', turn: 'turn-1', agentId: 'sub-1' },
      { name: 'crm/find', turn: 'turn-2', mcp: ['crm', 'find'] },
      { name: 'mcp__crm__thread', turn: null }
    ])
    const log = vi.fn()
    const sessions = await readLearnChainSessions(await journalOf(record('chat-a')), NOW, log)
    expect(sessions).toEqual([
      {
        sessionId: 'chat-a',
        turns: [
          { tools: [...CHAIN_KEYS, null, null], at: NOW - DAY },
          { tools: [chainCallKey('crm', 'find')], at: NOW - DAY }
        ]
      }
    ])
    expect(log).not.toHaveBeenCalled()
  })

  it('reads open and closed chats; skips remote, old and unconverted ones quietly', async () => {
    await chat('chat-open', claudeChain('t'))
    await (await chat('chat-closed', claudeChain('t'))).close()
    await chat('chat-remote', claudeChain('t'))
    await chat('chat-old', claudeChain('t'))
    const log = vi.fn()
    const journal = await journalOf(
      record('chat-open'),
      record('chat-closed'),
      record('chat-remote', { location: { executionHostId: 'ssh:box' } }),
      record('chat-old', { updatedAt: NOW - 31 * DAY }),
      record('chat-never-written')
    )
    const sessions = await readLearnChainSessions(journal, NOW, log)
    expect(sessions.map((session) => session.sessionId).sort()).toEqual([
      'chat-closed',
      'chat-open'
    ])
    expect(log).not.toHaveBeenCalled()
  })

  it('logs one line when reads fail for another reason', async () => {
    const log = vi.fn()
    const point = vi.fn(async () => {
      throw new Error('journal reader closed')
    })
    const sessions = await readLearnChainSessions(
      { records: () => [record('a'), record('b')], readers: { point } },
      NOW,
      log
    )
    expect(sessions).toEqual([])
    expect(point).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('refreshChains', () => {
  it('saves the chains found across chats and returns them', async () => {
    await chat('chat-a', claudeChain('turn-1'))
    await chat('chat-b', claudeChain('turn-9'))
    const refresh = deps(await journalOf(record('chat-a'), record('chat-b')))
    const chains = await refreshChains(refresh)
    expect(chains).toEqual([
      {
        kind: 'chain',
        signature: CHAIN_KEYS.join('\u001e'),
        tools: ['crm.find', 'crm.update', 'mail.send'],
        sessions: 2,
        occurrences: 2,
        lastSeen: NOW - DAY
      }
    ])
    expect(refresh.store.saveChains).toHaveBeenCalledWith(chains, NOW)
  })

  it('leaves out dismissed chains', async () => {
    await chat('chat-a', claudeChain('turn-1'))
    await chat('chat-b', claudeChain('turn-9'))
    const refresh = deps(await journalOf(record('chat-a'), record('chat-b')), [
      CHAIN_KEYS.join('\u001e')
    ])
    expect(await refreshChains(refresh)).toEqual([])
    expect(refresh.store.saveChains).toHaveBeenCalledWith([], NOW)
  })

  it('shares one refresh between concurrent callers', async () => {
    await chat('chat-a', claudeChain('turn-1'))
    await chat('chat-b', claudeChain('turn-9'))
    const journal = await journalOf(record('chat-a'), record('chat-b'))
    const records = vi.fn(journal.records)
    const refresh = deps({ ...journal, records })
    const [first, second] = await Promise.all([refreshChains(refresh), refreshChains(refresh)])
    expect(second).toBe(first)
    expect(records).toHaveBeenCalledTimes(1)
    expect(refresh.store.saveChains).toHaveBeenCalledTimes(1)
    await refreshChains(refresh)
    expect(records).toHaveBeenCalledTimes(2)
  })
})
