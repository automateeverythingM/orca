import { decideGate, type GateCall, type GateMode } from '../gate/codemode-gate'

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny' | 'unsupported'

export type ApprovalRequest = {
  title: string
  detail: string
  personOnly: boolean
  signal: AbortSignal
}

export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>

/** One inner call as the gate sees it; `allowKey` names what an allow_session answer covers. */
export type GateCheck = {
  gate: GateCall
  allowKey: string
  prompt: { title: string; detail: string }
}

export const DENIED_TEXT = 'denied by user'

/** What the script sees for a denied call: the call's label, so the agent can tell which one. */
export function deniedCallText(label: string): string {
  return `${label}: ${DENIED_TEXT}`
}
export const UNSUPPORTED_TEXT =
  'approval needed but this agent cannot show approval cards; switch the chat to full access or call the tool directly'
export const REFUSED_TEXT = 'not allowed in this chat mode'
export const INTERRUPTED_TEXT = 'Interrupted by user'

const DECISIONS = new Set<unknown>(['allow_once', 'allow_session', 'deny', 'unsupported'])

function ask(approver: Approver, request: ApprovalRequest): Promise<ApprovalDecision | null> {
  const { signal } = request
  if (signal.aborted) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    // Why: an approver that throws or answers garbage must fail closed.
    Promise.resolve()
      .then(() => approver(request))
      .then(
        (answer) => resolve(DECISIONS.has(answer) ? answer : 'deny'),
        () => resolve('deny')
      )
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Session-wide gate: the mode is read on every call; allow_session answers are kept by key. */
export class CodemodeApprovals {
  private readonly sessionAllowed = new Set<string>()

  constructor(private readonly mode: () => GateMode) {}

  /** Resolves null when the call may run, otherwise the refusal text the script sees. */
  async check(check: GateCheck, approver: Approver, signal: AbortSignal): Promise<string | null> {
    const decision = decideGate(check.gate, this.mode())
    if (decision === 'allow') {
      return null
    }
    if (decision === 'refuse') {
      return REFUSED_TEXT
    }
    if (this.sessionAllowed.has(check.allowKey)) {
      return null
    }
    const answer = await ask(approver, {
      ...check.prompt,
      personOnly: decision === 'ask-person-only',
      signal
    })
    switch (answer) {
      case 'allow_session':
        this.sessionAllowed.add(check.allowKey)
        return null
      case 'allow_once':
        return null
      case 'deny':
        return DENIED_TEXT
      case 'unsupported':
        return UNSUPPORTED_TEXT
      case null:
        return INTERRUPTED_TEXT
    }
  }
}
