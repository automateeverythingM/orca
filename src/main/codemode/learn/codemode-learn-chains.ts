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

/** A turn's tool calls in order: `server.tool` for a direct MCP call, `null` for any other call
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
  if (item.mcpIdentity) {
    const { server, tool } = item.mcpIdentity
    return server && tool ? { server, tool } : null
  }
  const match = CLAUDE_MCP_NAME.exec(item.name.trim())
  return match ? { server: match[1], tool: match[2] } : null
}

/** The key a direct call has inside a chain, or `null` for a call that is not direct. */
export function chainToolKey(
  item: Pick<AgentJournalToolCallItem, 'name' | 'mcpIdentity'>
): string | null {
  const direct = directMcpCall(item)
  return direct ? `${direct.server}.${direct.tool}` : null
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

/** Chains seen in 2+ chats within 30 days of `now`: most chats, then most occurrences, then newest. */
export function findRepeatedChains(
  sessions: readonly ChainSession[],
  now: number
): CodemodeRepeatedChain[] {
  const since = now - LEARN_RETENTION_MS
  const tallies = new Map<string, Tally>()
  for (const { sessionId, turns } of sessions) {
    for (const { tools, at } of turns) {
      if (at < since) {
        continue
      }
      for (const run of chainsInTurn(tools)) {
        const signature = run.join(' > ')
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
    .filter(([, tally]) => tally.sessions.size >= LEARN_CHAIN_MIN_SESSIONS)
    .map(([signature, tally]): CodemodeRepeatedChain => ({
      kind: 'chain',
      signature,
      tools: tally.tools,
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
