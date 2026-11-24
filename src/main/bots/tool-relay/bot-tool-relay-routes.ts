// The relay's route families: each names its targets by path, resolves its own tokens to a caller,
// and says per request whether that caller may reach that target.
import type { BotToolCredentialSource } from '../tool-oauth/bot-tool-credential-source'
import { RelayRefusal } from './bot-tool-relay-requests'

export type RelayAllowance = { ok: true } | { ok: false; status: 403 | 404; message: string }

/** Who a token speaks for: limits, open calls and upstream sessions are kept per `callerKey`. */
export type RelayCaller = { callerKey: string; folder: string }

export type RelayRoute = {
  /** Captures the target id, used as the credential id under the caller's folder. */
  pattern: RegExp
  resolve(token: string): RelayCaller | null
  /** Asked on every request, so a change applies to the next call. */
  allow(callerKey: string, targetId: string): RelayAllowance
  /** Where a target's address and secret come from; default is the relay's own. */
  source?: BotToolCredentialSource
  /** Pass on a saved-header session the relay never saw, as bots always have; else it starts over. */
  adoptsUnknownSessions?: boolean
  /** The 401 text for a missing or unknown token. */
  unauthorized?: string
}

/** Who the request's token speaks for, when it may reach the target; refuses it otherwise. */
export function admittedCaller(
  route: RelayRoute,
  targetId: string,
  authorization: string | undefined
): RelayCaller {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1]
  const caller = token ? route.resolve(token) : null
  if (!caller) {
    throw new RelayRefusal(401, route.unauthorized ?? 'This needs an Orca token.')
  }
  const allowance = route.allow(caller.callerKey, targetId)
  if (!allowance.ok) {
    throw new RelayRefusal(allowance.status, allowance.message)
  }
  return caller
}

export const botCallerKey = (botId: string): string => `bot:${botId}`

/** Bots' own tools: a bot's token reaches any credential in its folder. */
export function botRoute(
  pattern: RegExp,
  grantOf: (token: string) => { botId: string; folder: string } | undefined
): RelayRoute {
  return {
    pattern,
    resolve: (token) => {
      const grant = grantOf(token)
      return grant ? { callerKey: botCallerKey(grant.botId), folder: grant.folder } : null
    },
    allow: () => ({ ok: true }),
    adoptsUnknownSessions: true,
    unauthorized: 'This tool needs the bot’s Orca token.'
  }
}

export class RelayRoutes {
  private readonly routes: RelayRoute[] = []

  /** The returned function removes the route again. */
  add(route: RelayRoute): () => void {
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index !== -1) {
        this.routes.splice(index, 1)
      }
    }
  }

  match(url: string): { route: RelayRoute; targetId: string } | null {
    for (const route of this.routes) {
      const targetId = route.pattern.exec(url)?.[1]
      if (targetId) {
        return { route, targetId }
      }
    }
    return null
  }
}
