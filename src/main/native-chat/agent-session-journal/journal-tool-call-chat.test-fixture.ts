// Writes a chat of tool calls into a test journal database, for readers of tool-call rows.
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRowAttribution,
  type AgentJournalToolCallItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionJournal } from './journal-store'
import type { TrackedJournalOpener } from './store-lifecycle/journal-host-database-test-support'

export type FixtureToolCall = {
  name: string
  /** The owning turn's item id; `null` writes the call thread-scoped. */
  turn: string | null
  agentId?: string
  mcp?: [server: string, tool: string]
  observedAt?: number
  /** Text of the call's output head. */
  output?: string
}

function identity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle(`thread-${sessionId}`)
  }
}

/** A chat whose tool calls are written in this order; calls default to being seen at `at`. */
export async function writeToolCallChat(
  journals: TrackedJournalOpener,
  stateDirectory: string,
  sessionId: string,
  calls: readonly FixtureToolCall[],
  at: number
): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: identity(sessionId),
    stateDirectory,
    now: () => at
  })
  let ordinal = 0
  for (const { name, turn, agentId, mcp, observedAt, output } of calls) {
    ordinal += 1
    const body: AgentJournalToolCallItem = {
      kind: 'tool-call',
      name,
      input: {},
      state: 'completed',
      ...(mcp ? { mcpIdentity: { server: mcp[0], tool: mcp[1] } } : {}),
      ...(output === undefined
        ? {}
        : {
            output: { head: output, byteLength: output.length, digest: 'd', truncated: false }
          })
    }
    const attribution: AgentJournalRowAttribution = {
      turnScope: turn === null ? AGENT_JOURNAL_THREAD_SCOPE : { kind: 'turn', turnItemId: turn },
      ...(agentId ? { agentId } : {})
    }
    await journal.appendItem(
      { provider: 'codex', threadId: `thread-${sessionId}`, turnId: turn ?? 't0', ordinal },
      body,
      { fence: 1, observedAt: observedAt ?? at, ...attribution }
    )
  }
  return journal
}
