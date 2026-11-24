import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { renderMcpContent } from './codemode-mcp-content'
import type { CodemodeServerSpec } from './codemode-mcp-config'

export type { CodemodeServerSpec } from './codemode-mcp-config'

export type CodemodeToolInfo = { name: string; description?: string; input_schema: unknown }

type PoolOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  approveStart: (spec: CodemodeServerSpec) => Promise<boolean>
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
  private readonly allPids: number[] = []
  private started = 0

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
    return [...this.entries.keys()]
  }

  list(): { server: string; tools: string[] | null }[] {
    return [...this.entries.values()].map((entry) => ({
      server: entry.spec.name,
      tools: entry.tools ? entry.tools.map((tool) => tool.name) : null
    }))
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

  /** Resolves with rendered text; a tool result flagged isError rejects with that text. */
  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<string> {
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
    return text
  }

  async close(): Promise<void> {
    const lives: Live[] = []
    for (const entry of this.entries.values()) {
      if (entry.live) {
        lives.push(entry.live)
      }
      entry.live = null
      entry.starting = null
    }
    await Promise.all(lives.map((live) => live.client.close().catch(() => {})))
  }

  private entry(server: string): Entry {
    const entry = this.entries.get(server)
    if (!entry) {
      throw new Error(`unknown MCP server ${server}; known: ${this.names().join(', ')}`)
    }
    return entry
  }

  private async ensure(entry: Entry): Promise<Live> {
    if (entry.live?.alive) {
      return entry.live
    }
    if (entry.starting) {
      return entry.starting
    }
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
    entry.starting = this.start(entry).finally(() => {
      entry.starting = null
    })
    return entry.starting
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
