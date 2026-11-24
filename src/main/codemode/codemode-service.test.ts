import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotToolServer } from '../../shared/bot-tools'
import { FakeOAuthMcpServer } from '../bots/tool-oauth/testing/fake-oauth-mcp-server'
import { BotToolRelay } from '../bots/tool-relay/bot-tool-relay'
import { CodemodeConnectorPool } from './connectors/codemode-connector-pool'
import { setUpConnectorTestEnv } from './connectors/testing/codemode-connector-test-env'
import { fakeCrmServerSpec } from './mcp-pool/testing/fake-crm-command'
import { CodemodeHttpServer } from './server/codemode-http-server'
import { CodemodeService } from './codemode-service'

let bundleRoot: string
let workerPath: string
let root: string
let service: CodemodeService
const clients: Client[] = []

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  bundleRoot = mkdtempSync(join(cacheRoot, 'orca-codemode-service-'))
  workerPath = join(bundleRoot, 'codemode-worker-entry.js')
  await build({
    entryPoints: [resolve('src/main/codemode/sandbox/codemode-worker-entry.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'],
    logLevel: 'silent'
  })
}, 30_000)
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codemode-service-')))
  const crm = await fakeCrmServerSpec()
  await mkdir(join(root, '.orca'))
  await writeFile(
    join(root, '.orca', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'fake-crm': crm } })
  )
  service = new CodemodeService({ workerPath, log: () => {} })
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await service.stop()
  await rm(root, { recursive: true, force: true })
})

async function launchAll(sessionId = 's1', launchId = 'launch-1'): Promise<BotToolServer[]> {
  const servers = await service.launchServer({
    sessionId,
    launchId,
    root,
    env: process.env,
    mode: () => 'full-access'
  })
  if (!servers) {
    throw new Error('expected code mode to serve the session')
  }
  return servers
}

async function launch(sessionId = 's1', launchId = 'launch-1'): Promise<BotToolServer> {
  const [orca, ...rest] = await launchAll(sessionId, launchId)
  expect(rest).toEqual([])
  return orca
}

function urlServer(server: BotToolServer | null): { url: string; authorization: string } {
  if (!server || !('url' in server) || !server.headers?.authorization) {
    throw new Error('expected an http server with a bearer token')
  }
  return { url: server.url, authorization: server.headers.authorization }
}

async function connect(server: BotToolServer | null): Promise<Client> {
  const { url, authorization } = urlServer(server)
  const client = new Client({ name: 'agent', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization } }
    })
  )
  clients.push(client)
  return client
}

function initializeStatus(server: BotToolServer | null): Promise<number> {
  const { url, authorization } = urlServer(server)
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization
        }
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('error', reject)
    req.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' }
        }
      })
    )
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('CodemodeService', () => {
  it("gives a session an orca http server whose token runs the session's scripts", async () => {
    const server = await launch()
    expect(server).toMatchObject({ name: 'orca', transport: 'http' })
    expect(urlServer(server).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/codemode\/mcp$/)
    expect(urlServer(server).authorization).toMatch(/^Bearer [0-9a-f]{64}$/)
    const client = await connect(server)
    const result = await client.callTool({ name: 'run_js', arguments: { code: 'return 1 + 1' } })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '=> 2' }])
  })

  it("revokes the token at session end and stops the session's MCP servers", async () => {
    const server = await launch()
    const client = await connect(server)
    const result = await client.callTool({
      name: 'run_js',
      arguments: { code: "return await mcp['fake-crm'].pid()" }
    })
    const pid = Number(/\d+/.exec(JSON.stringify(result.content))?.[0])
    expect(alive(pid)).toBe(true)

    await service.endSession('s1')

    expect(await initializeStatus(server)).toBe(401)
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 })
  })

  it("leaves another session's token working when one session ends", async () => {
    const ended = await launch('s1')
    const kept = await launch('s2')
    await service.endSession('s1')
    expect(await initializeStatus(ended)).toBe(401)
    expect(await initializeStatus(kept)).toBe(200)
  })

  it("keeps a newer launch's token when the superseded launch's child ends late", async () => {
    await launch('s1', 'launch-a')
    service.bindChild('s1', 'launch-a', 'generation-a')
    const newer = await launch('s1', 'launch-b')

    await service.endChild('s1', 'generation-a')
    await service.endSession('s1', 'launch-a')
    expect(await initializeStatus(newer)).toBe(200)

    service.bindChild('s1', 'launch-b', 'generation-b')
    await service.endChild('s1', 'generation-b')
    expect(await initializeStatus(newer)).toBe(401)
  })

  it('ends a launch whose own child ended before its acquisition reported it', async () => {
    const server = await launch('s1', 'launch-a')
    await service.endChild('s1', 'generation-a')
    expect(await initializeStatus(server)).toBe(200)
    service.bindChild('s1', 'launch-a', 'generation-a')
    await vi.waitFor(async () => expect(await initializeStatus(server)).toBe(401))
  })

  it('launches without code mode when the server cannot start', async () => {
    const failing = new CodemodeHttpServer()
    failing.start = () => Promise.reject(new Error('EADDRINUSE'))
    const logged: string[] = []
    const broken = new CodemodeService({ server: failing, log: (message) => logged.push(message) })
    const input = { launchId: 'launch-1', root, env: {}, mode: () => 'ask' as const }
    expect(await broken.launchServer({ sessionId: 's1', ...input })).toBe(null)
    expect(await broken.launchServer({ sessionId: 's2', ...input })).toBe(null)
    expect(logged).toHaveLength(1)
  })
})

describe('CodemodeService connectors as direct servers', () => {
  let fake: FakeOAuthMcpServer | null = null
  let relay: BotToolRelay | null = null
  const env = setUpConnectorTestEnv(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
    await service.stop()
    service = new CodemodeService({ workerPath, log: () => {} })
    relay?.close()
    relay = null
    await fake?.stop()
    fake = null
  })

  /** Connector `fake` (a token connector) and a service wired to a real relay, as the app wires them. */
  async function withConnector(): Promise<string> {
    const { store, auth } = env.current()
    fake = await FakeOAuthMcpServer.start()
    const connector = store.add({ name: 'fake', url: fake.mcpUrl, auth: 'token' })
    fake.accessTokens.add('pasted-token')
    auth.setToken(connector.id, 'pasted-token')
    relay = new BotToolRelay((url, init) => fetch(url, init))
    await service.stop()
    service = new CodemodeService({
      workerPath,
      log: () => {},
      relay,
      connectors: async () => ({ store, auth, pool: new CodemodeConnectorPool(store, auth) })
    })
    return connector.id
  }

  it("gives the chat each usable connector at the relay route, with orca's token", async () => {
    const id = await withConnector()
    const [orca, connector] = await launchAll()
    const { authorization } = urlServer(orca)
    expect(connector).toEqual({
      name: 'fake',
      url: `${await relay!.origin()}/c/${id}/mcp`,
      transport: 'http',
      headers: { authorization }
    })
    const { tools } = await (await connect(connector)).listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['count', 'echo', 'whoami'])
  })

  it('leaves out a connector switched off for the chat or disabled, without starting the relay', async () => {
    const id = await withConnector()
    const origin = vi.spyOn(relay!, 'origin')
    await service.setConnectorOff('s1', id, true)
    expect((await launchAll('s1')).map((server) => server.name)).toEqual(['orca'])
    expect((await launchAll('s2')).map((server) => server.name)).toEqual(['orca', 'fake'])
    expect(origin).toHaveBeenCalledTimes(1)

    env.current().store.update(id, { enabled: false })
    expect((await launchAll('s2', 'launch-2')).map((server) => server.name)).toEqual(['orca'])
    expect((await launchAll('s1', 'launch-2')).map((server) => server.name)).toEqual(['orca'])
    expect(origin).toHaveBeenCalledTimes(1)
  })
})
