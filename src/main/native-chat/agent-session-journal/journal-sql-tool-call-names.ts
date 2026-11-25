// Tool-call names only: what code mode's Learn needs to find repeated call chains. Read on a journal
// reader worker straight from each row's stored JSON; never decodes a payload into an item, never
// touches output_blob, so a page of 5 MB tool outputs replies with a few hundred bytes per call.
import type { JournalSqlScope } from './journal-sql-scope'

/** Longest name, server, tool, agent or turn id text a row replies with. */
export const TOOL_CALL_NAME_MAX_CHARS = 512
/** Most rows one page replies with. */
export const TOOL_CALL_NAMES_MAX_LIMIT = 1000

export type JournalToolCallNamesRead = {
  kind: 'tool-call-names'
  afterOrdinal: number
  limit: number
  /** Only calls observed at or after this time. */
  since: number
}

/** One visible tool-call row: when it was seen, its turn, who made it, and what it called. */
export type JournalToolCallName = {
  ordinal: number
  observedAt: number
  /** The owning turn's item id; null when the call is thread-scoped or its turn is unknown. */
  turnItemId: string | null
  /** The producing subagent; null for the chat's own agent. */
  agentId: string | null
  name: string
  /** Codex's stated MCP identity, when present. */
  mcpServer: string | null
  mcpTool: string | null
}

export type JournalToolCallNamesResult = {
  kind: 'tool-call-names'
  calls: JournalToolCallName[]
  nextOrdinal: number | null
}

const text = (path: string) =>
  `substr(json_extract(payload_json,'${path}'),1,${TOOL_CALL_NAME_MAX_CHARS})`

const TOOL_CALL_NAMES_SQL = `SELECT ordinal,
    json_extract(payload_json,'$.observedAt') AS observed_at,
    CASE WHEN json_extract(payload_json,'$.turnScope.kind')='turn'
      THEN ${text('$.turnScope.turnItemId')} END AS turn_item_id,
    ${text('$.agentId')} AS agent_id,
    ${text('$.body.name')} AS name,
    ${text('$.body.mcpIdentity.server')} AS mcp_server,
    ${text('$.body.mcpIdentity.tool')} AS mcp_tool
  FROM journal_items INDEXED BY journal_items_kind
  WHERE session_id=? AND epoch=? AND hidden=0 AND kind='tool-call' AND ordinal>?
    AND json_valid(payload_json) AND json_extract(payload_json,'$.observedAt')>=?
  ORDER BY ordinal LIMIT ?`

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function readJournalToolCallNames(
  scope: JournalSqlScope,
  operation: JournalToolCallNamesRead
): JournalToolCallNamesResult {
  const limit = Math.max(1, Math.min(Math.floor(operation.limit), TOOL_CALL_NAMES_MAX_LIMIT))
  const rows = scope.db
    .prepare(TOOL_CALL_NAMES_SQL)
    .all(scope.sessionId, scope.epoch, operation.afterOrdinal, operation.since, limit + 1)
  const chosen = rows.slice(0, limit)
  return {
    kind: 'tool-call-names',
    calls: chosen.map((row) => ({
      ordinal: Number(row.ordinal),
      observedAt: Number(row.observed_at),
      turnItemId: textOrNull(row.turn_item_id),
      agentId: textOrNull(row.agent_id),
      name: textOrNull(row.name) ?? '',
      mcpServer: textOrNull(row.mcp_server),
      mcpTool: textOrNull(row.mcp_tool)
    })),
    nextOrdinal: rows.length > limit ? Number(chosen.at(-1)!.ordinal) : null
  }
}
