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

function launch(sessionId = 's1', launchId = 'launch-1'): Promise<BotToolServer | null> {
  return service.launchServer({
    sessionId,
    launchId,
    root,
    env: process.env,
    mode: () => 'full-access'
  })
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
