import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { renderMcpContent } from './codemode-mcp-content'
import type { CodemodeServerSpec } from './codemode-mcp-config'

export type { CodemodeServerSpec } from './codemode-mcp-config'

export type CodemodeToolInfo = { name: string; description?: string; input_schema: unknown }

/** `structured` is the tool's `structuredContent` when it sent one; `text` is the rendered content. */
export type CodemodeToolResult = { text: string; structured?: unknown }

/** Connectors by name, read live so a switch applies to the next call. */
export type CodemodeConnectorAccess = {
  /** Every connector's name, usable or not: a local server of that name never runs. */
  claimed(): string[]
  /** The connectors this chat may call now. */
  names(): string[]
  describe(name: string, signal?: AbortSignal): Promise<CodemodeToolInfo[]>
  call(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CodemodeToolResult>
}

type PoolOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  approveStart: (spec: CodemodeServerSpec) => Promise<boolean>
  /** Win over a local server of the same name and need no start approval. */
  connectors?: CodemodeConnectorAccess
}

type Live = { client: Client; transport: StdioClientTransport; alive: boolean }

type Entry = {
  spec: CodemodeServerSpec
  live: Live | null
  starting: Promise<Live> | null
  approved: boolean
  restartsThisTurn: number
  everStarted: boolean
  tools: CodemodeToolInfo[] | null
  stderr: string[]
}

const POOL_CLOSED = 'MCP pool is closed'
const REQUEST_TIMEOUT_MS = 600_000
const STDERR_FLUSH_MS = 100
const STDERR_LINES_KEPT = 5

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export class CodemodeMcpPool {
  private readonly entries = new Map<string, Entry>()
  private readonly connectorTools = new Map<string, string[]>()
  private readonly allPids: number[] = []
  private started = 0
  private closed = false

  constructor(
    specs: CodemodeServerSpec[],
    private readonly options: PoolOptions
  ) {
    for (const spec of specs) {
      this.entries.set(spec.name, {
        spec,
        live: null,
        starting: null,
        approved: false,
        restartsThisTurn: 0,
        everStarted: false,
        tools: null,
        stderr: []
      })
    }
  }

  names(): string[] {
    return [...(this.options.connectors?.names() ?? []), ...this.localNames()]
  }

  list(): { server: string; tools: string[] | null }[] {
    const connectors = this.options.connectors?.names() ?? []
    return [
      ...connectors.map((name) => ({ server: name, tools: this.connectorTools.get(name) ?? null })),
      ...this.localNames().map((name) => {
        const tools = this.entries.get(name)?.tools
        return { server: name, tools: tools ? tools.map((tool) => tool.name) : null }
      })
    ]
  }

  /** Number of server processes spawned so far (restarts included). */
  startedCount(): number {
    return this.started
  }

  /** Pids of every process this pool has spawned, for leak checks. */
  pids(): number[] {
    return [...this.allPids]
  }

  newTurn(): void {
    for (const entry of this.entries.values()) {
      entry.restartsThisTurn = 0
    }
  }

  async describe(server: string): Promise<CodemodeToolInfo[]> {
    const connectors = this.connectorsServing(server)
    if (connectors) {
      const tools = await connectors.describe(server)
      this.connectorTools.set(
        server,
        tools.map((tool) => tool.name)
      )
      return tools
    }
    const entry = this.entry(server)
    if (entry.tools && entry.live?.alive) {
      return entry.tools
    }
    const live = await this.ensure(entry)
    try {
      const listed = await live.client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })
      entry.tools = listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }))
      return entry.tools
    } catch (error) {
      throw await this.failure(entry, error)
    }
  }

  /** A tool result flagged isError rejects with its rendered text. */
  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CodemodeToolResult> {
    const connectors = this.connectorsServing(server)
    if (connectors) {
      return connectors.call(server, tool, args, signal)
    }
    const entry = this.entry(server)
    const live = await this.ensure(entry)
    let result: Awaited<ReturnType<Client['callTool']>>
    try {
      result = await live.client.callTool({ name: tool, arguments: args }, undefined, {
        signal,
        timeout: REQUEST_TIMEOUT_MS
      })
    } catch (error) {
      throw await this.failure(entry, error, signal)
    }
    const text = renderMcpContent(Array.isArray(result.content) ? result.content : [])
    if (result.isError) {
      throw new Error(text || `tool ${tool} failed`)
    }
    return result.structuredContent === undefined
      ? { text }
      : { text, structured: result.structuredContent }
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.entries.values()].flatMap((entry) =>
      entry.starting ? [entry.starting.catch(() => null)] : []
    )
    await Promise.all(pending)
    const lives: Live[] = []
    for (const entry of this.entries.values()) {
      if (entry.live) {
        lives.push(entry.live)
      }
      entry.live = null
    }
    await Promise.all(lives.map((live) => live.client.close().catch(() => {})))
  }

  private localNames(): string[] {
    const claimed = this.options.connectors?.claimed() ?? []
    return [...this.entries.keys()].filter((name) => !claimed.includes(name))
  }

  private connectorsServing(server: string): CodemodeConnectorAccess | null {
    if (this.closed) {
      throw new Error(POOL_CLOSED)
    }
    const { connectors } = this.options
    if (!connectors?.claimed().includes(server)) {
      return null
    }
    if (!connectors.names().includes(server)) {
      throw this.unknownServer(server)
    }
    return connectors
  }

  private unknownServer(server: string): Error {
    return new Error(`unknown MCP server ${server}; known: ${this.names().join(', ')}`)
  }

  private entry(server: string): Entry {
    const entry = this.entries.get(server)
    if (!entry) {
      throw this.unknownServer(server)
    }
    return entry
  }

  private ensure(entry: Entry): Promise<Live> {
    if (this.closed) {
      return Promise.reject(new Error(POOL_CLOSED))
    }
    if (entry.live?.alive) {
      return Promise.resolve(entry.live)
    }
    // One promise covers approval and spawn so concurrent first calls share a single start.
    entry.starting ??= this.begin(entry).finally(() => {
      entry.starting = null
    })
    return entry.starting
  }

  private async begin(entry: Entry): Promise<Live> {
    if (entry.everStarted) {
      if (entry.restartsThisTurn >= 1) {
        throw this.failedError(entry)
      }
      entry.restartsThisTurn++
    }
    if (!entry.approved) {
      if (!(await this.options.approveStart(entry.spec))) {
        throw new Error(`start of server ${entry.spec.name} was not approved`)
      }
      entry.approved = true
    }
    if (this.closed) {
      throw new Error(POOL_CLOSED)
    }
    return this.start(entry)
  }

  private async start(entry: Entry): Promise<Live> {
    const { spec } = entry
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...cleanEnv(this.options.env), ...spec.env },
      cwd: this.options.cwd,
      stderr: 'pipe'
    })
    const client = new Client({ name: 'orca-codemode', version: '1.0.0' })
    const live: Live = { client, transport, alive: true }
    entry.stderr = []
    transport.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean)
      entry.stderr = [...entry.stderr, ...lines].slice(-STDERR_LINES_KEPT)
    })
    transport.onclose = () => {
      live.alive = false
    }
    entry.everStarted = true
    this.started++
    try {
      await client.connect(transport)
    } catch (error) {
      live.alive = false
      await client.close().catch(() => {})
      throw await this.failure(entry, error)
    }
    if (transport.pid !== null) {
      this.allPids.push(transport.pid)
    }
    entry.live = live
    return live
  }

  private failedError(entry: Entry): Error {
    return new Error(`server ${entry.spec.name} failed: ${entry.stderr.join('\n')}`)
  }

  private async failure(entry: Entry, error: unknown, signal?: AbortSignal): Promise<Error> {
    if (signal?.aborted) {
      return error instanceof Error ? error : new Error('aborted')
    }
    if (entry.live?.alive) {
      return error instanceof Error ? error : new Error(String(error))
    }
    // Let the stderr pipe drain so the last lines include the crash reason.
    await new Promise((resolve) => setTimeout(resolve, STDERR_FLUSH_MS))
    return this.failedError(entry)
  }
}
