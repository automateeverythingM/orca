// Learn's repeated chains: the same 3+ direct MCP tool calls in a row, in one turn, in 2+ chats. Pure:
// the journal source hands in each chat's turns; nothing here reads a journal or a store.
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { CodemodeRepeatedChain } from '../../../shared/codemode/codemode-learn-types'
import { isCodemodeRunCall } from '../../../shared/codemode/codemode-run-match'
import { LEARN_RETENTION_MS } from './store/codemode-learn-rows'

/** Fewest consecutive direct calls that make a chain. */
export const LEARN_CHAIN_MIN_CALLS = 3
/** Fewest distinct chats a chain must appear in. */
export const LEARN_CHAIN_MIN_SESSIONS = 2
/** Most chains kept, most chats first. */
export const LEARN_MAX_CHAINS = 100

const CLAUDE_MCP_NAME = /^mcp__(.+?)__(.+)$/
/** Between a call's server and tool, and between a chain's calls: control characters no server or
 *  tool name holds, so `a.b`+`c` and `a`+`b.c` never share a key. */
const SERVER_TOOL_SEPARATOR = '\u001f'
const CALL_SEPARATOR = '\u001e'
const holdsSeparator = (name: string) =>
  name.includes(SERVER_TOOL_SEPARATOR) || name.includes(CALL_SEPARATOR)

/** A turn's tool calls in order: `chainCallKey` for a direct MCP call, `null` for any other call
 *  (a built-in tool or `run_js`), which breaks a chain. `at` is when the turn's calls were seen. */
export type ChainTurn = { tools: readonly (string | null)[]; at: number }
export type ChainSession = { sessionId: string; turns: readonly ChainTurn[] }

/** The server and tool of a direct MCP call: Codex states it, Claude names it `mcp__server__tool`.
 *  `run_js` and every non-MCP tool are not direct calls. */
export function directMcpCall(
  item: Pick<AgentJournalToolCallItem, 'name' | 'mcpIdentity'>
): { server: string; tool: string } | null {
  if (isCodemodeRunCall(item.name, item.mcpIdentity)) {
    return null
  }
  const match = item.mcpIdentity ? null : CLAUDE_MCP_NAME.exec(item.name.trim())
  const server = item.mcpIdentity?.server ?? match?.[1]
  const tool = item.mcpIdentity?.tool ?? match?.[2]
  if (!server || !tool || holdsSeparator(server) || holdsSeparator(tool)) {
    return null
  }
  return { server, tool }
}

/** A direct call's key inside a chain. */
export function chainCallKey(server: string, tool: string): string {
  return `${server}${SERVER_TOOL_SEPARATOR}${tool}`
}

/** The key a direct call has inside a chain, or `null` for a call that is not direct. */
export function chainToolKey(
  item: Pick<AgentJournalToolCallItem, 'name' | 'mcpIdentity'>
): string | null {
  const direct = directMcpCall(item)
  return direct ? chainCallKey(direct.server, direct.tool) : null
}

/** `server.tool`, for people to read; not a key. */
function displayTool(key: string): string {
  return key.replace(SERVER_TOOL_SEPARATOR, '.')
}

/** Each maximal run of consecutive direct calls in a turn that is long enough to be a chain. */
function chainsInTurn(tools: readonly (string | null)[]): string[][] {
  const runs: string[][] = []
  let run: string[] = []
  for (const tool of [...tools, null]) {
    if (tool !== null) {
      run.push(tool)
      continue
    }
    if (run.length >= LEARN_CHAIN_MIN_CALLS) {
      runs.push(run)
    }
    run = []
  }
  return runs
}

type Tally = { tools: string[]; sessions: Set<string>; occurrences: number; lastSeen: number }

/** Chains seen in 2+ chats within 30 days of `now` and not `dismissed`: most chats, then most
 *  occurrences, then newest. `signature` is the stored and dismiss key; `tools` reads `server.tool`. */
export function findRepeatedChains(
  sessions: readonly ChainSession[],
  now: number,
  dismissed: ReadonlySet<string> = new Set()
): CodemodeRepeatedChain[] {
  const since = now - LEARN_RETENTION_MS
  const tallies = new Map<string, Tally>()
  for (const { sessionId, turns } of sessions) {
    for (const { tools, at } of turns) {
      if (at < since) {
        continue
      }
      for (const run of chainsInTurn(tools)) {
        const signature = run.join(CALL_SEPARATOR)
        const tally = tallies.get(signature) ?? {
          tools: run,
          sessions: new Set<string>(),
          occurrences: 0,
          lastSeen: at
        }
        tally.sessions.add(sessionId)
        tally.occurrences += 1
        tally.lastSeen = Math.max(tally.lastSeen, at)
        tallies.set(signature, tally)
      }
    }
  }
  return [...tallies]
    .filter(
      ([signature, tally]) =>
        tally.sessions.size >= LEARN_CHAIN_MIN_SESSIONS && !dismissed.has(signature)
    )
    .map(([signature, tally]): CodemodeRepeatedChain => ({
      kind: 'chain',
      signature,
      tools: tally.tools.map(displayTool),
      sessions: tally.sessions.size,
      occurrences: tally.occurrences,
      lastSeen: tally.lastSeen
    }))
    .sort(
      (a, b) =>
        b.sessions - a.sessions ||
        b.occurrences - a.occurrences ||
        b.lastSeen - a.lastSeen ||
        a.signature.localeCompare(b.signature)
    )
    .slice(0, LEARN_MAX_CHAINS)
}
