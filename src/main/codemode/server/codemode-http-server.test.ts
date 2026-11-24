import { request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Approver } from '../host/codemode-run-host'
import { CodemodeHttpServer, type CodemodeSessionHandle } from './codemode-http-server'

type RunOpts = { signal: AbortSignal; approver: Approver }
type RunImpl = (code: string, opts: RunOpts) => Promise<{ text: string; isError: boolean }>

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' }
  }
})

let server: CodemodeHttpServer
let origin: string
const clients: Client[] = []

function stubSession(run: RunImpl): CodemodeSessionHandle {
  return { run, serverNames: () => ['crm'], close: async () => {} }
}

function register(run: RunImpl, sessionId = 'session-1'): string {
  return server.register(sessionId, stubSession(run), () => ({ servers: ['crm'] }))
}

async function connect(
  token: string,
  answer?: (request: ElicitRequest) => ElicitResult
): Promise<Client> {
  const client = new Client(
    { name: 'test-agent', version: '1.0.0' },
    { capabilities: answer ? { elicitation: {} } : {} }
  )
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => answer(req))
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/codemode/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

function post(headers: Record<string, string>): Promise<number> {
  const url = new URL(`${origin}/codemode/mcp`)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers
        }
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('error', reject)
    req.end(INITIALIZE)
  })
}

const askOnce = (approver: Approver, signal: AbortSignal) =>
  approver({ title: 'Run bash', detail: 'rm -rf build', personOnly: false, signal })

beforeEach(async () => {
  server = new CodemodeHttpServer({ progressMs: 50 })
  ;({ origin } = await server.start())
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await server.stop()
})

describe('CodemodeHttpServer', () => {
  it('binds to loopback and refuses calls without the token, from a page, or to another host', async () => {
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const token = register(async () => ({ text: 'ok', isError: false }))
    const port = new URL(origin).port
    const auth = { authorization: `Bearer ${token}` }
    expect(await post({})).toBe(401)
    expect(await post({ authorization: `Bearer ${'0'.repeat(64)}` })).toBe(401)
    expect(await post({ ...auth, origin: 'https://evil.example' })).toBe(403)
    expect(await post({ ...auth, host: `evil.example:${port}` })).toBe(403)
    expect(await post({ ...auth, host: `localhost:${port}` })).toBe(403)
    expect(await post(auth)).toBe(200)
  })

  it('lists exactly run_js, always loaded, described for the session', async () => {
    const client = await connect(register(async () => ({ text: 'ok', isError: false })))
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['run_js'])
    expect(tools[0]!._meta?.['anthropic/alwaysLoad']).toBe(true)
    expect(tools[0]!.description).toContain('MCP servers: crm.')
    expect(tools[0]!.inputSchema.required).toEqual(['code'])
  })

  it("returns the session's result text", async () => {
    const client = await connect(register(async (code) => ({ text: `ran ${code}`, isError: true })))
    const result = await client.callTool({ name: 'run_js', arguments: { code: 'return 1' } })
    expect(result.content).toEqual([{ type: 'text', text: 'ran return 1' }])
    expect(result.isError).toBe(true)
  })

  it('sends progress while a run is longer than progressMs', async () => {
    let progressed: () => void = () => {}
    const sawProgress = new Promise<void>((resolve) => (progressed = resolve))
    const client = await connect(
      register(async () => {
        await sawProgress
        return { text: 'done', isError: false }
      })
    )
    const result = await client.callTool({ name: 'run_js', arguments: { code: 'x' } }, undefined, {
      onprogress: () => progressed()
    })
    expect(result.content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('aborts the run when the agent cancels the call', async () => {
    let started: () => void = () => {}
    const sawStart = new Promise<void>((resolve) => (started = resolve))
    let aborted: () => void = () => {}
    const sawAbort = new Promise<void>((resolve) => (aborted = resolve))
    const client = await connect(
      register(
        (_code, { signal }) =>
          new Promise((resolve) => {
            started()
            signal.addEventListener('abort', () => {
              aborted()
              resolve({ text: 'stopped', isError: true })
            })
          })
      )
    )
    const cancel = new AbortController()
    const call = client.callTool({ name: 'run_js', arguments: { code: 'x' } }, undefined, {
      signal: cancel.signal
    })
    await sawStart
    cancel.abort()
    await expect(call).rejects.toThrow()
    await sawAbort
  })

  it('asks the agent through elicitation and returns its decision', async () => {
    const asked: ElicitRequest[] = []
    const token = register(async (_code, { approver, signal }) => ({
      text: await askOnce(approver, signal),
      isError: false
    }))
    const client = await connect(token, (req) => {
      asked.push(req)
      return { action: 'accept', content: { decision: 'allow_session' } }
    })
    const result = await client.callTool({ name: 'run_js', arguments: { code: 'x' } })
    expect(result.content).toEqual([{ type: 'text', text: 'allow_session' }])
    expect(asked[0]!.params).toMatchObject({
      message: 'Run bash\n\nrm -rf build',
      requestedSchema: {
        properties: { decision: { enum: ['allow_once', 'allow_session', 'deny'] } },
        required: ['decision']
      },
      _meta: {
        'anthropic/permissionDisplay': {
          title: 'Run bash',
          displayName: 'Code mode',
          description: 'rm -rf build'
        }
      }
    })
  })

  it('treats a declined approval as deny', async () => {
    const token = register(async (_code, { approver, signal }) => ({
      text: await askOnce(approver, signal),
      isError: false
    }))
    const client = await connect(token, () => ({ action: 'decline' }))
    const result = await client.callTool({ name: 'run_js', arguments: { code: 'x' } })
    expect(result.content).toEqual([{ type: 'text', text: 'deny' }])
  })

  it('answers unsupported when the agent cannot show elicitation', async () => {
    const token = register(async (_code, { approver, signal }) => ({
      text: await askOnce(approver, signal),
      isError: false
    }))
    const client = await connect(token)
    const result = await client.callTool({ name: 'run_js', arguments: { code: 'x' } })
    expect(result.content).toEqual([{ type: 'text', text: 'unsupported' }])
  })

  it('keeps one live connection per token: a new initialize replaces an idle one', async () => {
    const token = register(async () => ({ text: 'ok', isError: false }))
    const first = await connect(token)
    await first.listTools()
    const second = await connect(token)
    await expect(first.listTools()).rejects.toThrow()
    expect((await second.listTools()).tools.map((tool) => tool.name)).toEqual(['run_js'])
  })

  it("stops accepting a session's token once it is unregistered", async () => {
    const token = register(async () => ({ text: 'ok', isError: false }))
    const client = await connect(token)
    await client.listTools()
    await server.unregister('session-1')
    expect(await post({ authorization: `Bearer ${token}` })).toBe(401)
    await expect(client.listTools()).rejects.toThrow()
  })
})
