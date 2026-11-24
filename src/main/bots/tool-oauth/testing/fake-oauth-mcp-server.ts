import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { FakeOAuthApp, type Hit } from './fake-oauth-app'

type Session = { mcp: McpServer; transport: StreamableHTTPServerTransport; tools: RegisteredTool[] }
type StartOptions = { requireAuth?: boolean; tokenTtlSeconds?: number }

const TOOL_NAMES = ['echo', 'whoami', 'count']

/** A fake MCP app that is also its own OAuth authorization server, for connector tests. */
export class FakeOAuthMcpServer extends FakeOAuthApp {
  private requireAuth = true
  private redirectTo: string | null = null
  private enabledTools = new Set(TOOL_NAMES)
  private sessions = new Map<string, Session>()
  private mcpSessions = 0
  private calls = 0
  private held: Promise<void> | null = null

  static async start(opts: StartOptions = {}): Promise<FakeOAuthMcpServer> {
    const fake = new FakeOAuthMcpServer()
    fake.requireAuth = opts.requireAuth ?? true
    fake.tokenTtlSeconds = opts.tokenTtlSeconds ?? 3600
    await fake.start()
    return fake
  }

  get mcpUrl(): string {
    return this.url
  }

  /** The user approving in a browser: follow the authorize URL, then call the client's callback. */
  async approve(authorizeUrl: string): Promise<void> {
    const authorized = await fetch(authorizeUrl, { redirect: 'manual' })
    const location = authorized.headers.get('location')
    if (authorized.status !== 302 || !location) {
      throw new Error(`authorize answered ${authorized.status} without a redirect`)
    }
    await fetch(location)
  }

  expireAccessTokens(): void {
    this.accessTokens.clear()
  }

  revokeAll(): void {
    this.accessTokens.clear()
    for (const token of this.refreshTokens) {
      this.revokedRefreshTokens.add(token)
    }
  }

  redirectMcpTo(url: string | null): void {
    this.redirectTo = url
  }

  counts(): { tokenRequests: number; refreshes: number; mcpSessions: number; calls: number } {
    const tokens = this.hitsTo('/token').map((hit) => tokenGrant(hit))
    return {
      tokenRequests: tokens.length,
      refreshes: tokens.filter((grant) => grant === 'refresh_token').length,
      mcpSessions: this.mcpSessions,
      calls: this.calls
    }
  }

  /** Enables exactly these tools; the SDK sends tools/list_changed to connected clients. */
  setTools(names: string[]): void {
    this.enabledTools = new Set(names)
    for (const session of this.sessions.values()) {
      applyEnabled(session.tools, this.enabledTools)
    }
  }

  /** Tool calls arriving from now on wait until the returned release is called. */
  holdCalls(): () => void {
    let release = () => {}
    this.held = new Promise<void>((resolve) => {
      release = resolve
    })
    return () => {
      this.held = null
      release()
    }
  }

  async stop(): Promise<void> {
    const open = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(open.map(({ mcp }) => mcp.close().catch(() => {})))
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  protected override namesAuthServer(): boolean {
    return this.requireAuth
  }

  protected override async handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    body: Hit['body']
  ): Promise<void> {
    if (this.redirectTo) {
      res.writeHead(302, { location: this.redirectTo })
      res.end()
      return
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (this.requireAuth && (!bearer || !this.accessTokens.has(bearer))) {
      this.unauthorized(res)
      return
    }
    const header = req.headers['mcp-session-id']
    const sessionId = Array.isArray(header) ? header[0] : header
    const known = sessionId ? this.sessions.get(sessionId) : undefined
    if (known) {
      await known.transport.handleRequest(req, res, body)
    } else if (req.method === 'POST' && isInitializeRequest(body)) {
      await this.openSession().transport.handleRequest(req, res, body)
    } else {
      res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: sessionId ? 'unknown session' : 'no session' }))
    }
  }

  private openSession(): Session {
    const mcp = new McpServer({ name: 'fake-oauth-mcp', version: '1.0.0' })
    const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
    const counted = async (): Promise<void> => {
      this.calls += 1
      await this.held
    }
    const tools = [
      mcp.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text: input }) => {
        await counted()
        return text(input)
      }),
      mcp.registerTool('whoami', { outputSchema: { user: z.string() } }, async () => {
        await counted()
        return { ...text('fake'), structuredContent: { user: 'fake' } }
      }),
      mcp.registerTool('count', {}, async () => {
        await counted()
        return text(String(this.calls))
      })
    ]
    applyEnabled(tools, this.enabledTools)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.mcpSessions += 1
        this.sessions.set(id, session)
      }
    })
    const session: Session = { mcp, transport, tools }
    void mcp.connect(transport)
    return session
  }
}

function applyEnabled(tools: RegisteredTool[], enabled: Set<string>): void {
  tools.forEach((tool, index) => {
    const wanted = enabled.has(TOOL_NAMES[index]!)
    if (wanted !== tool.enabled) {
      if (wanted) {
        tool.enable()
      } else {
        tool.disable()
      }
    }
  })
}

function tokenGrant(hit: Hit): string {
  return hit.body instanceof URLSearchParams ? (hit.body.get('grant_type') ?? '') : ''
}
