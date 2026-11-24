import type { OrcaMethodLabel } from '../orca/codemode-orca-method-policy'
import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'

export type GateCall =
  | { kind: 'read' }
  | { kind: 'write' }
  | { kind: 'bash' }
  | { kind: 'mcp'; server: string; trusted: boolean }
  | { kind: 'mcp-start'; server: string }
  | { kind: 'path-outside' }
  | { kind: 'orca'; label: OrcaMethodLabel }

export type GateMode = AgentChatPermissionChoice | 'read-only'

export type GateDecision = 'allow' | 'ask' | 'ask-person-only' | 'refuse'

// Why: pure so the mode can be re-read per call and a mid-script mode change
// takes effect at the next inner call.
export function decideGate(call: GateCall, mode: GateMode): GateDecision {
  if (call.kind === 'read' || (call.kind === 'orca' && call.label === 'read')) {
    return 'allow'
  }
  if (mode === 'read-only') {
    return 'refuse'
  }
  const strict = mode === 'own' || mode === 'ask'
  switch (call.kind) {
    case 'write':
      return strict ? 'ask' : 'allow'
    case 'bash':
      return mode === 'full-access' ? 'allow' : 'ask'
    case 'mcp':
      return call.trusted || mode === 'full-access' ? 'allow' : 'ask'
    case 'mcp-start':
      return mode === 'full-access' ? 'allow' : 'ask-person-only'
    case 'orca':
      // Why: destructive Orca calls ask even in full-access; only a write label follows the mode.
      return call.label === 'write' && !strict ? 'allow' : 'ask'
    case 'path-outside':
      return strict ? 'refuse' : 'ask'
  }
}
