import type { NativeChatMcpIdentity } from '../native-chat/tools/native-chat-tool-identity'

const SERVER = 'orca'
const TOOL = 'run_js'

/** Claude names the call `mcp__orca__run_js` and Codex `orca/run_js`; an explicit identity wins. */
export function isCodemodeRunCall(name: string, identity?: NativeChatMcpIdentity): boolean {
  if (identity) {
    return identity.server === SERVER && identity.tool === TOOL
  }
  const trimmed = name.trim()
  return trimmed === `mcp__${SERVER}__${TOOL}` || trimmed === `${SERVER}/${TOOL}`
}

export function codemodeCallCode(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || !('code' in input)) {
    return null
  }
  return typeof input.code === 'string' ? input.code : null
}

export type CodemodeCandidateCall = {
  callId: string
  name: string
  input: unknown
  mcpIdentity?: NativeChatMcpIdentity
}

/** The earliest running run_js call with this code that no other run has taken. */
export function matchRunToCall(
  session: {
    runningToolCalls: readonly CodemodeCandidateCall[]
    matchedCallIds?: ReadonlySet<string>
  },
  code: string
): string | null {
  for (const call of session.runningToolCalls) {
    if (
      isCodemodeRunCall(call.name, call.mcpIdentity) &&
      !session.matchedCallIds?.has(call.callId) &&
      codemodeCallCode(call.input) === code
    ) {
      return call.callId
    }
  }
  return null
}
