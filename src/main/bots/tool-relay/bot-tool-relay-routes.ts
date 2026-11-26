// Route families added to the relay beside its bots' and host list's tools (code mode's connectors):
// each names its targets by path, resolves its own tokens to a caller, and says per request whether
// that caller may reach that target.
import type { IncomingMessage } from 'node:http'
import type { BotToolCredentialSource } from '../tool-oauth/bot-tool-credential-source'
import {
  MCP_HOST_LIST_RELAY_OWNER,
  relayToolPath,
  type RelayGrants,
  type RelayToolPath
} from './bot-tool-relay-grants'
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
  /** The sign-in-needed answer's text for a target; default is the bots' wording. */
  signInNeeded?(targetId: string): string
  /** The 404 text when the source has no such target; default is the bots' wording. */
  missing?: string
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

/** The caller a relay grant's owner (a bot, or the host list's shared token) calls as. */
export const botCallerKey = (owner: string): string => `bot:${owner}`

/** What a request reaches: a tool by its credential id under the caller's folder, or a host list
 *  command server Orca runs once (`process`). */
export type RelayTarget = {
  /** Limits, open calls and upstream sessions are kept per caller: `bot:<owner>` or a route's. */
  callerKey: string
  folder: string
  /** The credential id, or `process:<id>` for a command server. */
  entry: string
  process?: string
  /** A token many sessions share: only this computer's limits bound its calls. */
  shared: boolean
  /** An added route family (code mode's connectors); absent for bots' and the host list's tools. */
  route?: RelayRoute
}

/** An added route's caller, when its token may reach the target; refused otherwise. */
export function routedTarget(
  route: RelayRoute,
  targetId: string,
  authorization: string | undefined
): RelayTarget {
  const caller = admittedCaller(route, targetId, authorization)
  return {
    callerKey: caller.callerKey,
    folder: caller.folder,
    entry: targetId,
    shared: false,
    route
  }
}

/** The bot's or the host's token's reach to a tool or command server under its folder. */
export function grantTarget(
  grants: Pick<RelayGrants, 'of'>,
  match: RelayToolPath,
  authorization: string | undefined
): RelayTarget {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1]
  const grant = token ? grants.of(token) : undefined
  if (!grant) {
    throw new RelayRefusal(401, 'This tool needs the bot’s Orca token.')
  }
  const folder = grant.folders[match.scope]
  if (!folder) {
    throw new RelayRefusal(404, 'This token has no such tool.')
  }
  return {
    callerKey: botCallerKey(grant.owner),
    folder,
    entry: match.process === undefined ? match.credentialId : `process:${match.process}`,
    ...(match.process === undefined ? {} : { process: match.process }),
    // Every non-bot session shares the host's token, so only this computer's limits bound its calls.
    shared: grant.owner === MCP_HOST_LIST_RELAY_OWNER
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

/** Checks loopback origin/host, matches the route or tool path, and authorizes the target. */
export function resolveRelayTarget(
  routes: RelayRoutes,
  grants: Pick<RelayGrants, 'of'>,
  req: IncomingMessage,
  port: number
): { method: string; target: RelayTarget } {
  const host = req.headers.host
  // A browser page can reach loopback too; Orca's agents send no Origin and name this address.
  if (
    req.headers.origin !== undefined ||
    (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
  ) {
    throw new RelayRefusal(403, 'Not allowed.')
  }
  const url = req.url ?? ''
  const routed = routes.match(url)
  const match = routed ? null : relayToolPath(url)
  if (!routed && !match) {
    throw new RelayRefusal(404, 'Not found.')
  }
  const method = req.method ?? ''
  if (!['POST', 'GET', 'DELETE'].includes(method)) {
    throw new RelayRefusal(405, 'Method not allowed.')
  }
  const target = routed
    ? routedTarget(routed.route, routed.targetId, req.headers.authorization)
    : grantTarget(grants, match!, req.headers.authorization)
  return { method, target }
}
