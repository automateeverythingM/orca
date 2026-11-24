// Loopback MCP server that native-chat agents call for code mode; each session has its own token.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CODEMODE_LIMITS } from '../codemode-limits'
import {
  createCodemodeMcpServer,
  type CodemodeConnectionState,
  type CodemodeSessionHandle
} from './codemode-mcp-connection'
import { CodemodeTokens } from './codemode-tokens'

export type { CodemodeSessionHandle } from './codemode-mcp-connection'

type Connection = {
  mcp: McpServer
  transport: StreamableHTTPServerTransport
  state: CodemodeConnectionState
}
type Registration = {
  sessionId: string
  session: CodemodeSessionHandle
  describeInput: () => { servers: string[] }
  connections: Map<string, Connection>
}

const PATH = /^\/codemode\/mcp(?:\?.*)?$/
const METHODS = new Set(['POST', 'GET', 'DELETE'])
const BUSY_TEXT =
  'This session is running a script on another connection; try again when it finishes.'

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

async function closeConnections(registration: Registration): Promise<void> {
  const open = [...registration.connections.values()]
  registration.connections.clear()
  await Promise.all(open.map(({ mcp }) => mcp.close().catch(() => {})))
}

export class CodemodeHttpServer {
  private server: Server | null = null
  private port = 0
  private starting: Promise<{ origin: string }> | null = null
  private readonly tokens = new CodemodeTokens()
  private readonly registrations = new Map<string, Registration>()
  private readonly progressMs: number

  constructor(opts: { progressMs?: number } = {}) {
    this.progressMs = opts.progressMs ?? CODEMODE_LIMITS.progressMs
  }

  start(): Promise<{ origin: string }> {
    this.starting ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res)
      })
      // Why: a run streams for as long as it takes; only slow request headers are cut.
      server.requestTimeout = 0
      server.headersTimeout = 10_000
      server.once('error', (error) => {
        this.starting = null
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        server.unref()
        this.server = server
        this.port = address && typeof address === 'object' ? address.port : 0
        resolve({ origin: `http://127.0.0.1:${this.port}` })
      })
    })
    return this.starting
  }

  /** Returns the session's bearer token; registering again replaces the old token and connections. */
  register(
    sessionId: string,
    session: CodemodeSessionHandle,
    describeInput: () => { servers: string[] }
  ): string {
    const previous = this.registrations.get(sessionId)
    if (previous) {
      void closeConnections(previous)
    }
    this.registrations.set(sessionId, { sessionId, session, describeInput, connections: new Map() })
    return this.tokens.issue(sessionId)
  }

  /** Revokes the token and closes the session's connections, aborting their runs. */
  async unregister(sessionId: string): Promise<void> {
    this.tokens.revoke(sessionId)
    const registration = this.registrations.get(sessionId)
    this.registrations.delete(sessionId)
    if (registration) {
      await closeConnections(registration)
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.registrations.keys()].map((id) => this.unregister(id)))
    const server = this.server
    this.server = null
    this.starting = null
    this.port = 0
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.dispatch(req, res, this.admit(req))
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const refusal = error instanceof Refusal ? error : new Refusal(500, 'Internal error.')
      res.writeHead(refusal.status, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: refusal.message },
          id: null
        })
      )
    }
  }

  private admit(req: IncomingMessage): Registration {
    // Why: a browser page can reach loopback too; agents send no Origin and name this exact address.
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${this.port}`) {
      throw new Refusal(403, 'Not allowed.')
    }
    if (!PATH.test(req.url ?? '')) {
      throw new Refusal(404, 'Not found.')
    }
    if (!METHODS.has(req.method ?? '')) {
      throw new Refusal(405, 'Method not allowed.')
    }
    const auth = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
    const sessionId = auth?.[1] ? this.tokens.resolve(auth[1]) : null
    const registration = sessionId ? this.registrations.get(sessionId) : undefined
    if (!registration) {
      throw new Refusal(401, 'Code mode needs this session’s token.')
    }
    return registration
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    registration: Registration
  ): Promise<void> {
    const mcpSessionId = req.headers['mcp-session-id']
    if (typeof mcpSessionId === 'string') {
      const connection = registration.connections.get(mcpSessionId)
      if (!connection) {
        // MCP clients start a new session on 404.
        throw new Refusal(404, 'Session not found.')
      }
      await connection.transport.handleRequest(req, res)
      return
    }
    if (req.method !== 'POST') {
      throw new Refusal(400, 'Missing mcp-session-id.')
    }
    await this.openConnection(req, res, registration)
  }

  /**
   * One live connection per token: a new initialize replaces an idle connection (an agent that
   * reconnected without DELETE), and is refused while a script runs on the current one.
   */
  private async openConnection(
    req: IncomingMessage,
    res: ServerResponse,
    registration: Registration
  ): Promise<void> {
    const { connections } = registration
    const busy = (): boolean => [...connections.values()].some(({ state }) => state.running > 0)
    if (busy()) {
      throw new Refusal(409, BUSY_TEXT)
    }
    const state: CodemodeConnectionState = { running: 0 }
    const mcp = createCodemodeMcpServer(
      registration.session,
      registration.describeInput,
      this.progressMs,
      state
    )
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        // A script started on the old connection meanwhile: it keeps the session; this one is dropped below.
        if (busy()) {
          return
        }
        for (const [oldId, old] of connections) {
          void old.mcp.close()
          connections.delete(oldId)
        }
        connections.set(id, { mcp, transport, state })
      }
    })
    mcp.server.onclose = () => {
      if (transport.sessionId && connections.get(transport.sessionId)?.mcp === mcp) {
        connections.delete(transport.sessionId)
      }
    }
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
    // Not an initialize, displaced by a running script, or the session was unregistered meanwhile.
    if (
      !transport.sessionId ||
      connections.get(transport.sessionId)?.mcp !== mcp ||
      this.registrations.get(registration.sessionId) !== registration
    ) {
      connections.delete(transport.sessionId ?? '')
      await mcp.close()
    }
  }
}
