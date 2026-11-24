// Which upstream identity each MCP session was made under, per credential and caller, so a changed
// identity, an ended sign-in or another caller's session id starts over instead of going through.
import type { IncomingMessage } from 'node:http'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import { header, RelayRefusal } from './bot-tool-relay-requests'
import type { ReadyAnswer } from './bot-tool-relay-upstream'

const MAX_TRACKED_SESSIONS = 1_000
export const SESSION_ENDED = 'This tool’s session ended. Start a new one.'

/** The sessions of one credential for one caller live under `${credentialKey}\0${callerKey}`. */
export const sessionScope = (credentialKey: string, callerKey: string): string =>
  `${credentialKey}\0${callerKey}`

export class RelaySessions {
  private readonly identities = new BoundedMap<string, string>({
    maxEntries: MAX_TRACKED_SESSIONS
  })

  /** A session the relay never saw under this upstream identity has to start over. */
  check(req: IncomingMessage, scope: string, answer: ReadyAnswer, adoptsUnknown: boolean): void {
    const sessionId = header(req, 'mcp-session-id')
    if (!sessionId) {
      return
    }
    const known = this.identities.get(`${scope}\0${sessionId}`)
    // Saved headers adopt an unknown session on bot routes; a sign-in never does, so one made under
    // an ended sign-in can't come back under the next. MCP clients start a new session on 404.
    const stale =
      known === undefined ? !adoptsUnknown || answer.bearer !== undefined : known !== answer.session
    if (stale) {
      throw new RelayRefusal(404, SESSION_ENDED)
    }
  }

  /** Remembers the session the server handed out, and forgets one the agent closed. */
  record(req: IncomingMessage, scope: string, answer: ReadyAnswer, upstream: Response): void {
    const sessionId = header(req, 'mcp-session-id')
    const returned = upstream.headers.get('mcp-session-id')
    if (returned) {
      this.identities.set(`${scope}\0${returned}`, answer.session)
    }
    if (req.method === 'DELETE' && sessionId && upstream.ok) {
      this.identities.delete(`${scope}\0${sessionId}`)
    }
  }

  dropCredential(credentialKey: string): void {
    this.dropWhere((session) => session.startsWith(`${credentialKey}\0`))
  }

  dropCaller(callerKey: string): void {
    this.dropWhere((session) => session.includes(`\0${callerKey}\0`))
  }

  clear(): void {
    this.identities.clear()
  }

  private dropWhere(matches: (session: string) => boolean): void {
    for (const session of this.identities.keys()) {
      if (matches(session)) {
        this.identities.delete(session)
      }
    }
  }
}
