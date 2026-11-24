import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CodemodeConnector } from '../../../shared/codemode/codemode-connector-types'
import { renderMcpContent } from '../mcp-pool/codemode-mcp-content'
import type {
  CodemodeToolInfo,
  CodemodeToolResult
} from '../mcp-pool/codemode-mcp-connector-access'
import type { CodemodeConnectorAuth } from './codemode-connector-auth'
import { connectorFetch } from './codemode-connector-fetch'
import type { CodemodeConnectorStore } from './codemode-connector-store'

type Live = { client: Client; alive: boolean }

type Entry = {
  id: string
  /** What the client was opened for; a change to either reopens it. */
  url: string
  auth: CodemodeConnector['auth']
  live: Live | null
  connecting: Promise<Live> | null
  tools: CodemodeToolInfo[] | null
}

const POOL_CLOSED = 'connector pool is closed'
const REQUEST_TIMEOUT_MS = 600_000
const CONNECT_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolArguments(args: unknown): Record<string, unknown> {
  if (args === undefined) {
    return {}
  }
  if (!isRecord(args)) {
    throw new Error('tool arguments must be an object')
  }
  return args
}

/** The upstream forgot this session (it restarted or expired it): a new one may work. */
const sessionLost = (live: Live, error: unknown): boolean =>
  !live.alive || (error instanceof StreamableHTTPError && error.code === 404)

function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return work
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** One upstream MCP client per connector, shared by every chat. */
export class CodemodeConnectorPool {
  private readonly entries = new Map<string, Entry>()
  private readonly unsubscribe: () => void
  private closed = false

  constructor(
    private readonly store: CodemodeConnectorStore,
    private readonly auth: CodemodeConnectorAuth
  ) {
    this.unsubscribe = store.onChange(() => this.onStoreChange())
  }

  async describe(id: string, signal?: AbortSignal): Promise<CodemodeToolInfo[]> {
    return this.withClient(id, signal, async (entry, live) => {
      if (entry.tools) {
        return entry.tools
      }
      const listed = await live.client.listTools(undefined, { signal, timeout: REQUEST_TIMEOUT_MS })
      const tools = listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }))
      if (entry.live === live) {
        entry.tools = tools
      }
      return tools
    })
  }

  /** A tool result flagged isError rejects with its rendered text. */
  async call(
    id: string,
    tool: string,
    args: unknown,
    signal: AbortSignal
  ): Promise<CodemodeToolResult> {
    const params = { name: tool, arguments: toolArguments(args) }
    const result = await this.withClient(id, signal, (_entry, live) =>
      live.client.callTool(params, undefined, { signal, timeout: REQUEST_TIMEOUT_MS })
    )
    const text = renderMcpContent(Array.isArray(result.content) ? result.content : [])
    if (result.isError) {
      throw new Error(text || `tool ${tool} failed`)
    }
    return result.structuredContent === undefined
      ? { text }
      : { text, structured: result.structuredContent }
  }

  async close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) {
      return
    }
    this.entries.delete(id)
    await this.shut(entry)
  }

  async closeAll(): Promise<void> {
    this.closed = true
    this.unsubscribe()
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map((entry) => this.shut(entry)))
  }

  /** Open upstream sessions for this connector: 0 or 1. */
  sessionCount(id: string): number {
    return this.entries.get(id)?.live?.alive ? 1 : 0
  }

  /** Runs `work` on the connector's client; a session the upstream dropped is reopened once. */
  private async withClient<T>(
    id: string,
    signal: AbortSignal | undefined,
    work: (entry: Entry, live: Live) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const entry = this.entry(id)
      const live = await untilAborted(this.ensure(entry), signal)
      try {
        return await work(entry, live)
      } catch (error) {
        const current = this.entries.get(id) === entry
        if (attempt > 0 || signal?.aborted || !current || !sessionLost(live, error)) {
          throw error
        }
        this.drop(entry, live)
      }
    }
  }

  private entry(id: string): Entry {
    if (this.closed) {
      throw new Error(POOL_CLOSED)
    }
    const connector = this.store.get(id)
    if (!connector) {
      throw new Error(`unknown connector: ${id}`)
    }
    if (!connector.enabled) {
      throw new Error(`connector ${connector.name} is turned off`)
    }
    let entry = this.entries.get(id)
    if (!entry) {
      entry = {
        id,
        url: connector.url,
        auth: connector.auth,
        live: null,
        connecting: null,
        tools: null
      }
      this.entries.set(id, entry)
    }
    return entry
  }

  private ensure(entry: Entry): Promise<Live> {
    if (entry.live?.alive) {
      return Promise.resolve(entry.live)
    }
    // Concurrent first calls share one connect.
    entry.connecting ??= this.connect(entry).finally(() => {
      entry.connecting = null
    })
    return entry.connecting
  }

  private async connect(entry: Entry): Promise<Live> {
    const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
      fetch: connectorFetch(entry.id, this.store, this.auth)
    })
    const client = new Client({ name: 'orca-codemode', version: '1.0.0' })
    const live: Live = { client, alive: true }
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (entry.live === live) {
        entry.tools = null
      }
    })
    transport.onclose = () => {
      live.alive = false
    }
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
    } catch (error) {
      live.alive = false
      await client.close().catch(() => {})
      throw error
    }
    if (this.entries.get(entry.id) !== entry) {
      // Closed while connecting: whoever waited on this connect fails with the rest.
      live.alive = false
      await client.close().catch(() => {})
      throw new Error(`connector ${entry.id} was closed`)
    }
    entry.live = live
    entry.tools = null
    return live
  }

  private drop(entry: Entry, live: Live): void {
    if (entry.live === live) {
      entry.live = null
      entry.tools = null
    }
    live.alive = false
    void live.client.close().catch(() => {})
  }

  private async shut(entry: Entry): Promise<void> {
    const live = entry.live
    entry.live = null
    entry.tools = null
    if (live) {
      live.alive = false
      await live.client.close().catch(() => {})
    }
    await entry.connecting?.catch(() => null)
  }

  private onStoreChange(): void {
    for (const entry of this.entries.values()) {
      const connector = this.store.get(entry.id)
      const stale =
        !connector ||
        !connector.enabled ||
        connector.url !== entry.url ||
        connector.auth !== entry.auth
      if (stale) {
        void this.close(entry.id)
      }
    }
  }
}
