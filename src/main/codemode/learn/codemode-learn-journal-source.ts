// Reads recent chats' tool calls for Learn's repeated chains. Every read is a `tool-call-names`
// reader-pool point read, answered on a journal reader worker thread with names, turns and times only
// (never a payload or output); main runs no SQL. Open and closed chats read the same way, from the
// profile's one chat journal database, without opening (or converting) a chat.
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { CodemodeRepeatedChain } from '../../../shared/codemode/codemode-learn-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import type { JournalSqlReaderPool } from '../../native-chat/agent-session-journal/journal-sql-reader-pool'
import type { JournalToolCallNamesResult } from '../../native-chat/agent-session-journal/journal-sql-tool-call-names'
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
const PAGE_LIMIT = 500
/** What the reader says for a chat with no SQL journal yet; such chats are skipped quietly. */
const NOT_CONVERTED = 'chat needs conversion before reading'

export type LearnChainRecord = Pick<AgentSessionRecord, 'sessionId' | 'updatedAt'> & {
  location: Pick<AgentSessionRecord['location'], 'executionHostId'>
}

export type LearnChainJournal = {
  /** The chat records: `AgentSessionRecordStore.listRecords`. */
  records: () => readonly LearnChainRecord[]
  /** The profile's chat journal readers: `JournalSqlDatabase.readers`. */
  readers: Pick<JournalSqlReaderPool, 'point'>
}

export type LearnChainLog = (message: string, error?: unknown) => void

export type RefreshChainsDeps = {
  journal: LearnChainJournal
  store: Pick<CodemodeLearnRemote, 'saveChains' | 'dismissed'>
  now: () => number
  log: LearnChainLog
}

export function chainsAreFresh(computedAt: number | null, now: number): boolean {
  return computedAt !== null && now - computedAt >= 0 && now - computedAt < LEARN_CHAINS_FRESH_MS
}

async function toolCallPage(
  readers: LearnChainJournal['readers'],
  sessionId: string,
  afterOrdinal: number,
  since: number
): Promise<JournalToolCallNamesResult> {
  const result = await readers.point({
    sessionId,
    operation: { kind: 'tool-call-names', afterOrdinal, limit: PAGE_LIMIT, since }
  })
  if (result.kind !== 'tool-call-names') {
    throw new Error(`journal reader answered ${result.kind} for tool-call-names`)
  }
  return result
}

/** One chat's top-level tool calls seen since `since`, grouped by turn in journal order. Calls a
 *  subagent made, or that no turn owns, are left out: they interleave with the turn's own calls. */
async function readChatTurns(
  readers: LearnChainJournal['readers'],
  sessionId: string,
  since: number
): Promise<ChainTurn[]> {
  const turns = new Map<string, { tools: (string | null)[]; at: number }>()
  let after = -1
  for (;;) {
    const page = await toolCallPage(readers, sessionId, after, since)
    for (const call of page.calls) {
      if (call.agentId !== null || call.turnItemId === null) {
        continue
      }
      const mcpIdentity =
        call.mcpServer !== null && call.mcpTool !== null
          ? { server: call.mcpServer, tool: call.mcpTool }
          : undefined
      const turn = turns.get(call.turnItemId) ?? { tools: [], at: call.observedAt }
      turn.tools.push(chainToolKey({ name: call.name, mcpIdentity }))
      turn.at = Math.max(turn.at, call.observedAt)
      turns.set(call.turnItemId, turn)
    }
    if (page.nextOrdinal === null) {
      return [...turns.values()]
    }
    after = page.nextOrdinal
  }
}

const notConverted = (error: unknown) =>
  error instanceof Error && error.message.includes(NOT_CONVERTED)

/** Local chats updated in the last 30 days, each with its turns. A chat not yet in the SQL journal is
 *  skipped quietly; any other failed read skips its chat and the refresh logs one line for them all. */
export async function readLearnChainSessions(
  journal: LearnChainJournal,
  now: number,
  log: LearnChainLog
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
  const failures: unknown[] = []
  // Why: one chat at a time keeps Learn's background reads from crowding the readers chats use.
  for (const { sessionId } of recent) {
    try {
      const turns = await readChatTurns(journal.readers, sessionId, since)
      if (turns.length > 0) {
        sessions.push({ sessionId, turns })
      }
    } catch (error) {
      if (!notConverted(error)) {
        failures.push(error)
      }
    }
  }
  if (failures.length > 0) {
    log(`Learn could not read ${failures.length} of ${recent.length} chats for chains`, failures[0])
  }
  return sessions
}

let inFlight: Promise<CodemodeRepeatedChain[]> | null = null

async function refresh(deps: RefreshChainsDeps): Promise<CodemodeRepeatedChain[]> {
  const now = deps.now()
  const sessions = await readLearnChainSessions(deps.journal, now, deps.log)
  const chains = findRepeatedChains(sessions, now, new Set(await deps.store.dismissed()))
  await deps.store.saveChains(chains, now)
  return chains
}

/** Recomputes the repeated chains from chat journals and saves them to the Learn store. Callers that
 *  ask while a refresh runs share it. */
export function refreshChains(deps: RefreshChainsDeps): Promise<CodemodeRepeatedChain[]> {
  inFlight ??= refresh(deps).finally(() => {
    inFlight = null
  })
  return inFlight
}
