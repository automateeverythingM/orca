// Reads recent chats' tool calls for Learn's repeated chains. Every read is a reader-pool point read,
// answered on a journal reader worker thread; main runs no SQL. Open and closed chats read the same
// way, from the profile's one chat journal database, without opening (or converting) a chat.
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { CodemodeRepeatedChain } from '../../../shared/codemode/codemode-learn-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import type { JournalSqlReaderPool } from '../../native-chat/agent-session-journal/journal-sql-reader-pool'
import { journalSqlReads } from '../../native-chat/agent-session-journal/journal-sql-reads'
import type { CodemodeLearnRemote } from './store/codemode-learn-ops'
import { LEARN_RETENTION_MS } from './store/codemode-learn-rows'
import {
  chainToolKey,
  findRepeatedChains,
  type ChainSession,
  type ChainTurn
} from './codemode-learn-chains'

/** Callers reuse the saved chains while `computedAt` is younger than this. */
export const LEARN_CHAINS_FRESH_MS = 10 * 60 * 1000
/** Most chats read per refresh, most recently updated first. */
export const LEARN_CHAIN_MAX_SESSIONS = 300

export type LearnChainRecord = Pick<AgentSessionRecord, 'sessionId' | 'updatedAt'> & {
  location: Pick<AgentSessionRecord['location'], 'executionHostId'>
}

export type LearnChainJournal = {
  /** The chat records: `AgentSessionRecordStore.listRecords`. */
  records: () => readonly LearnChainRecord[]
  /** The profile's chat journal readers: `JournalSqlDatabase.readers`. */
  readers: Pick<JournalSqlReaderPool, 'point'>
}

export type RefreshChainsDeps = {
  journal: LearnChainJournal
  store: Pick<CodemodeLearnRemote, 'saveChains'>
  now: () => number
}

export function chainsAreFresh(computedAt: number | null, now: number): boolean {
  return computedAt !== null && now - computedAt >= 0 && now - computedAt < LEARN_CHAINS_FRESH_MS
}

/** One chat's top-level tool calls, grouped by turn in journal order. Calls a subagent made, or
 *  that no turn owns, are left out: they interleave with the turn's own calls. */
async function readChatTurns(
  readers: LearnChainJournal['readers'],
  sessionId: string
): Promise<ChainTurn[]> {
  const turns = new Map<string, { tools: (string | null)[]; at: number }>()
  await journalSqlReads(readers, sessionId).visitItems(
    { kinds: ['tool-call'] },
    (_itemId, _sequence, body, linkage, item) => {
      if (body.kind !== 'tool-call' || linkage.agentId !== undefined) {
        return
      }
      if (linkage.turnScope?.kind !== 'turn') {
        return
      }
      const turn = turns.get(linkage.turnScope.turnItemId) ?? { tools: [], at: item.observedAt }
      turn.tools.push(chainToolKey(body))
      turn.at = Math.max(turn.at, item.observedAt)
      turns.set(linkage.turnScope.turnItemId, turn)
    }
  )
  return [...turns.values()]
}

/** Local chats updated in the last 30 days, each with its turns; a chat whose journal cannot be
 *  read (never written, not yet converted, removed meanwhile) is skipped. */
export async function readLearnChainSessions(
  journal: LearnChainJournal,
  now: number
): Promise<ChainSession[]> {
  const since = now - LEARN_RETENTION_MS
  const recent = journal
    .records()
    .filter(
      (record) =>
        record.location.executionHostId === LOCAL_EXECUTION_HOST_ID && record.updatedAt >= since
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, LEARN_CHAIN_MAX_SESSIONS)
  const sessions: ChainSession[] = []
  // Why: one chat at a time keeps Learn's background reads from crowding the readers chats use.
  for (const { sessionId } of recent) {
    try {
      const turns = await readChatTurns(journal.readers, sessionId)
      if (turns.length > 0) {
        sessions.push({ sessionId, turns })
      }
    } catch {
      continue
    }
  }
  return sessions
}

/** Recomputes the repeated chains from chat journals and saves them to the Learn store. */
export async function refreshChains(deps: RefreshChainsDeps): Promise<CodemodeRepeatedChain[]> {
  const now = deps.now()
  const chains = findRepeatedChains(await readLearnChainSessions(deps.journal, now), now)
  await deps.store.saveChains(chains, now)
  return chains
}
