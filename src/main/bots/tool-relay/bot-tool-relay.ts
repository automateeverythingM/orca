// Orca's loopback relay for bots' HTTP tools: a bot's agent sends each call to 127.0.0.1 with its own
// token, and Orca adds the tool's saved headers or its own sign-in's token and streams it to the
// real server and back.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import {
  COMPOSIO_HEADER_SOURCE,
  COMPOSIO_SESSION_MCP_URL
} from '../../../shared/composio/composio-apps'
import { readComposioKey } from '../../composio/composio-key-store'
import { getMainHttpClient } from '../../network/http-client'
import { onBotToolCredentialEnded, type BotToolCredentialEnded } from '../bot-tool-credential-ended'
import {
  botToolCredentialSource,
  type BotToolCredentialAnswer,
  type BotToolCredentialRequest,
  type BotToolCredentialSource,
  type BotToolHeaderSource
} from '../tool-oauth/bot-tool-credential-source'
import { RelayAdmission, type RelayCall } from './bot-tool-relay-admission'
import { readBody, RelayRefusal } from './bot-tool-relay-requests'
import {
  admittedCaller,
  botCallerKey,
  botRoute,
  RelayRoutes,
  type RelayCaller,
  type RelayRoute
} from './bot-tool-relay-routes'
import { RelaySessions, SESSION_ENDED, sessionScope } from './bot-tool-relay-sessions'
import { answerSignInNeeded, answerUnavailable } from './bot-tool-relay-sign-in-answer'
import {
  sendUpstream,
  streamUpstreamResponse,
  refusalProblem,
  type ReadyAnswer,
  type RelayFetch
} from './bot-tool-relay-upstream'

type Grant = { botId: string; folder: string }

const PATH = /^\/bot-tools\/([A-Za-z0-9_-]{8,64})\/mcp(?:\?.*)?$/
const MAX_TRACKED_PROBLEMS = 1_000
/** Why a call was aborted: the agent hung up, or the tool, its sign-in or the bot went. */
const AGENT_LEFT = Symbol('agent left')
const CREDENTIAL_ENDED = Symbol('credential ended')

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')
const credentialKey = (folder: string, credentialId: string) => `${folder}\0${credentialId}`

export class BotToolRelay {
  private server: Server | null = null
  private port = 0
  private listening: Promise<number> | null = null
  private stopListeningForEnds: (() => void) | null = null
  private readonly grants = new Map<string, Grant>()
  private readonly tokens = new Map<string, string>()
  private readonly sessions = new RelaySessions()
  private readonly problems = new BoundedMap<string, string>({ maxEntries: MAX_TRACKED_PROBLEMS })
  private readonly admission = new RelayAdmission()
  private readonly routes = new RelayRoutes()

  constructor(
    private readonly fetchUpstream: RelayFetch,
    private readonly source: BotToolCredentialSource = botToolCredentialSource()
  ) {
    this.routes.add(botRoute(PATH, (token) => this.grants.get(hashToken(token))))
  }

  /** Another route family on this relay; the returned function removes it. */
  addRoute(route: RelayRoute): () => void {
    return this.routes.add(route)
  }

  /** The relay's address for this run of Orca; starts listening on first use. */
  async origin(): Promise<string> {
    return `http://127.0.0.1:${await this.listen()}`
  }

  /** The relay's address and the bot's token for this run of Orca; starts listening on first use. */
  async grant(botId: string, folder: string): Promise<{ origin: string; token: string }> {
    const port = await this.listen()
    let token = this.tokens.get(botId)
    if (!token) {
      token = randomBytes(32).toString('base64url')
      this.tokens.set(botId, token)
    }
    this.grants.set(hashToken(token), { botId, folder: resolve(folder) })
    return { origin: `http://127.0.0.1:${port}`, token }
  }

  /** The bot a token was granted to in this run of Orca; null once revoked or from another run. */
  botOf(token: string): string | null {
    return this.grants.get(hashToken(token))?.botId ?? null
  }

  /** A deleted bot's token stops working at once, and its open calls are cut. */
  revoke(botId: string): void {
    const token = this.tokens.get(botId)
    if (token) {
      this.grants.delete(hashToken(token))
      this.tokens.delete(botId)
    }
    this.admission.abortWhere((call) => call.callerKey === botCallerKey(botId), CREDENTIAL_ENDED)
  }

  /** A caller whose token ended: its open calls are cut and its upstream sessions forgotten. */
  endCaller(callerKey: string): void {
    this.admission.abortWhere((call) => call.callerKey === callerKey, CREDENTIAL_ENDED)
    this.sessions.dropCaller(callerKey)
  }

  /** Why the tool's server last refused, for the Tools row; null when it hasn't. */
  lastProblem(folder: string, credentialId: string): string | null {
    return this.problems.peek(credentialKey(resolve(folder), credentialId)) ?? null
  }

  /** Stops listening, drops open calls, and forgets every token, session and problem. */
  close(): void {
    this.admission.abortWhere(() => true, CREDENTIAL_ENDED)
    this.stopListeningForEnds?.()
    this.stopListeningForEnds = null
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = null
    this.port = 0
    this.listening = null
    this.grants.clear()
    this.tokens.clear()
    this.sessions.clear()
    this.problems.clear()
  }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolveListening, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res)
      })
      // Streams stay open as long as the tool keeps them; only slow request headers are cut.
      server.requestTimeout = 0
      server.headersTimeout = 10_000
      server.once('error', (error) => {
        this.listening = null
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        server.unref()
        this.server = server
        this.port = address && typeof address === 'object' ? address.port : 0
        this.stopListeningForEnds ??= onBotToolCredentialEnded((ended) => this.ended(ended))
        resolveListening(this.port)
      })
    })
    return this.listening
  }

  /** A removed tool, a replaced or signed-out sign-in: its calls and streams stop, its sessions go. */
  private ended({ folder, credentialId }: BotToolCredentialEnded): void {
    const key = credentialKey(folder, credentialId)
    this.admission.abortWhere((call) => call.credentialKey === key, CREDENTIAL_ENDED)
    this.sessions.dropCredential(key)
    this.problems.delete(key)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let call: RelayCall | null = null
    let label = ''
    try {
      const port = this.port
      const host = req.headers.host
      // A browser page can reach loopback too; Orca's agents send no Origin and name this address.
      if (
        req.headers.origin !== undefined ||
        (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      ) {
        throw new RelayRefusal(403, 'Not allowed.')
      }
      const match = this.routes.match(req.url ?? '')
      if (!match) {
        throw new RelayRefusal(404, 'Not found.')
      }
      const method = req.method ?? ''
      if (!['POST', 'GET', 'DELETE'].includes(method)) {
        throw new RelayRefusal(405, 'Method not allowed.')
      }
      const { route, targetId: credentialId } = match
      const caller = admittedCaller(route, credentialId, req.headers.authorization)
      const key = credentialKey(caller.folder, credentialId)
      label = `${caller.callerKey} ${credentialId} ${method}`
      // Counted before any wait for a token, so slow refreshes can't pile up calls.
      call = this.admission.admit(caller.callerKey, method, key)
      if (!call) {
        throw new RelayRefusal(429, 'Too many tool calls at once.')
      }
      const { abort } = call
      res.on('close', () => {
        if (!res.writableFinished) {
          abort.abort(AGENT_LEFT)
        }
      })
      await this.forward(req, res, caller, route, credentialId, abort.signal)
    } catch (error) {
      this.fail(res, call?.abort.signal, error, label)
    } finally {
      if (call) {
        this.admission.release(call)
      }
    }
  }

  private fail(
    res: ServerResponse,
    signal: AbortSignal | undefined,
    error: unknown,
    label: string
  ): void {
    const reason: unknown = signal?.aborted ? signal.reason : null
    if (reason === AGENT_LEFT || res.headersSent) {
      // A stream that started is cut, never replayed: the call may already have run.
      res.destroy()
      return
    }
    const refusal =
      reason === CREDENTIAL_ENDED
        ? new RelayRefusal(404, SESSION_ENDED)
        : error instanceof RelayRefusal
          ? error
          : new RelayRefusal(502, 'Orca couldn’t reach this tool’s server.')
    if (refusal.status >= 500 && label) {
      console.warn(`[bot-tool-relay] ${label} failed: ${refusal.message}`)
    }
    res.writeHead(refusal.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: refusal.message }))
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    caller: RelayCaller,
    route: RelayRoute,
    credentialId: string,
    signal: AbortSignal
  ): Promise<void> {
    const body = req.method === 'POST' ? await readBody(req) : undefined
    const key = credentialKey(caller.folder, credentialId)
    const scope = sessionScope(key, caller.callerKey)
    const source = route.source ?? this.source
    const request = { host: 'local', folder: caller.folder, credentialId, signal } as const
    let answer = await this.ask(source, request)
    let upstream: Response
    for (let tries = 1; ; tries += 1) {
      if (answer.kind === 'sign-in-needed') {
        answerSignInNeeded(req, res, body)
        return
      }
      if (answer.kind === 'unavailable') {
        answerUnavailable(req, res, body)
        return
      }
      if (answer.kind === 'missing') {
        throw new RelayRefusal(404, 'This bot has no such tool.')
      }
      this.sessions.check(req, scope, answer, route.adoptsUnknownSessions === true)
      upstream = await sendUpstream(this.fetchUpstream, req, answer, body, signal)
      // Only Orca's own sign-in can renew a refused token; saved headers are passed on as refused.
      if (upstream.status !== 401 || answer.bearer === undefined) {
        break
      }
      await upstream.body?.cancel()
      if (tries === 2) {
        // A token fresh from the app was refused too: only a new sign-in helps.
        answerSignInNeeded(req, res, body)
        return
      }
      answer = await this.ask(source, { ...request, rejected: answer.bearer })
    }
    const label = `${caller.callerKey} ${credentialId} ${req.method}`
    await this.relayResponse(req, res, { key, scope }, label, answer, upstream, signal)
  }

  /**
   * The source's answer; one that fails outright is a call that can't go through now. A call cut
   * while it waited (agent gone, tool removed) answers as cut, whatever the source said.
   */
  private async ask(
    source: BotToolCredentialSource,
    request: BotToolCredentialRequest
  ): Promise<BotToolCredentialAnswer> {
    let answer: BotToolCredentialAnswer
    try {
      answer = await source(request)
    } catch {
      answer = { kind: 'unavailable' }
    }
    request.signal.throwIfAborted()
    return answer
  }

  private async relayResponse(
    req: IncomingMessage,
    res: ServerResponse,
    { key, scope }: { key: string; scope: string },
    label: string,
    answer: ReadyAnswer,
    upstream: Response,
    signal: AbortSignal
  ): Promise<void> {
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel()
      throw new RelayRefusal(
        502,
        'The tool’s server redirected; Orca won’t send its saved values elsewhere.'
      )
    }
    if (upstream.status === 401 || upstream.status === 403) {
      this.problems.set(key, refusalProblem(upstream, answer))
      console.warn(`[bot-tool-relay] ${label} ${upstream.status}`)
    } else if (upstream.ok) {
      this.problems.delete(key)
    }
    this.sessions.record(req, scope, answer, upstream)
    await streamUpstreamResponse(res, upstream, signal)
  }
}

/** The owner's current Composio key, read per call so a changed or removed key applies to the next
 *  one; only ever to Composio's own session address, whatever the saved entry names. */
export const composioHeaderSource =
  (readKey: () => string | null | Promise<string | null>): BotToolHeaderSource =>
  async (credential) => {
    if (!COMPOSIO_SESSION_MCP_URL.test(credential.url)) {
      return null
    }
    const key = await readKey()
    return key ? { 'x-api-key': key } : null
  }

/** The relay for this process; upstream calls follow Orca's proxy settings. */
export const botToolRelay = new BotToolRelay(
  (url, init) => getMainHttpClient().fetch(url, init),
  botToolCredentialSource({ [COMPOSIO_HEADER_SOURCE]: composioHeaderSource(readComposioKey) })
)
