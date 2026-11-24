import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeOAuthMcpServer } from '../../bots/tool-oauth/testing/fake-oauth-mcp-server'
import { BotToolRelay } from '../../bots/tool-relay/bot-tool-relay'
import { CodemodeService } from '../codemode-service'
import { CodemodeConnectorPool } from './codemode-connector-pool'
import {
  codemodeServerTrust,
  connectorsOffValue,
  readConnectorsOff,
  writeConnectorsOff
} from './codemode-connector-session-switch'
import { setUpConnectorTestEnv } from './testing/codemode-connector-test-env'

const KEY = 'codemode.connectorsOff'

describe('connectorsOff option', () => {
  it('round-trips ids and keeps the other options', () => {
    const options = writeConnectorsOff({ model: 'm' }, ['b-2_X', 'a1'])
    expect(options).toEqual({ model: 'm', [KEY]: 'a1,b-2_X' })
    expect(readConnectorsOff({ options })).toEqual(new Set(['a1', 'b-2_X']))
  })

  it('never writes an empty value, which a session record cannot hold', () => {
    expect(connectorsOffValue({}, [])).not.toBe('')
    expect(readConnectorsOff({ options: { [KEY]: connectorsOffValue({}, ['bad id']) } })).toEqual(
      new Set()
    )
  })

  it('drops the key when nothing is off', () => {
    expect(writeConnectorsOff({ model: 'm', [KEY]: 'a1' }, [])).toEqual({ model: 'm' })
  })

  it('ignores empty and garbage values', () => {
    expect(readConnectorsOff(null)).toEqual(new Set())
    expect(readConnectorsOff({})).toEqual(new Set())
    expect(readConnectorsOff({ options: { [KEY]: '' } })).toEqual(new Set())
    expect(readConnectorsOff({ options: { [KEY]: ',, ,bad id!,a1,x;y,' } })).toEqual(
      new Set(['a1'])
    )
    expect(writeConnectorsOff({}, ['', 'bad id', 'a,b', 'ok'])).toEqual({ [KEY]: 'ok' })
  })
})

describe('codemodeServerTrust', () => {
  it('never trusts a connector name through the local setting, usable or not', () => {
    const trusted = codemodeServerTrust({
      connectors: { claimed: () => ['crm', 'docs'] },
      connectorTrusted: (name) => name === 'docs',
      trustedServers: () => ['crm', 'local']
    })
    expect(['crm', 'docs', 'local', 'other'].map(trusted)).toEqual([false, true, true, false])
  })
})

describe('CodemodeService.setConnectorOff', () => {
  it('refuses without writing when connectors could not be opened', async () => {
    const written: string[] = []
    const service = new CodemodeService({
      log: () => {},
      connectors: async () => {
        throw new Error('store unreadable')
      },
      sessionOptions: {
        read: () => ({ [KEY]: 'a1' }),
        writeOption: async (_sessionId, key) => {
          written.push(key)
        }
      }
    })
    await expect(service.setConnectorOff('s1', 'a1', false)).rejects.toThrow(
      'connectors unavailable'
    )
    expect(written).toEqual([])
  })
})

let bundleRoot: string
let workerPath: string
let fake: FakeOAuthMcpServer | null = null
let service: CodemodeService | null = null
let client: Client | null = null

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  bundleRoot = mkdtempSync(join(cacheRoot, 'orca-codemode-connector-switch-'))
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

const relay = new BotToolRelay((url, init) => fetch(url, init))
const env = setUpConnectorTestEnv(async () => {
  await client?.close().catch(() => {})
  client = null
  await service?.stop()
  service = null
  relay.close()
  await fake?.stop()
  fake = null
})

async function runJs(code: string): Promise<{ text: string; isError: boolean }> {
  const result = await client!.callTool({ name: 'run_js', arguments: { code } })
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
  return { text, isError: result.isError === true }
}

describe('connectors in run_js', () => {
  it('calls a connector until the chat switches it off', async () => {
    const { dir, store, auth } = env.current()
    fake = await FakeOAuthMcpServer.start({ requireAuth: false })
    const connector = await auth.add({ url: fake.mcpUrl, name: 'fake' })
    const saved = new Map<string, Readonly<Record<string, string>>>()
    service = new CodemodeService({
      workerPath,
      log: () => {},
      relay,
      connectors: async () => ({ store, auth, pool: new CodemodeConnectorPool(store, auth) }),
      sessionOptions: {
        read: (sessionId) => saved.get(sessionId),
        writeOption: async (sessionId, key, value) => {
          saved.set(sessionId, { ...saved.get(sessionId), [key]: value })
        }
      }
    })
    const [server] = (await service.launchServer({
      sessionId: 's1',
      launchId: 'launch-1',
      root: dir,
      env: process.env,
      mode: () => 'full-access'
    })) ?? [null]
    if (!server || !('url' in server) || !server.headers?.authorization) {
      throw new Error('expected an http server with a bearer token')
    }
    client = new Client({ name: 'agent', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: server.headers.authorization } }
      })
    )
    const script = "return await mcp.fake.echo({ text: 'hi' })"

    const on = await runJs(script)
    expect(on.isError).toBe(false)
    expect(on.text.split('\n')[0]).toBe('=> "hi"')
    expect(service.connectorsForSession('s1')).toEqual([
      { connector, on: true, status: 'connected' }
    ])

    await service.setConnectorOff('s1', connector.id, true)

    expect(saved.get('s1')).toEqual({ [KEY]: connector.id })
    expect(service.connectorsForSession('s1')[0].on).toBe(false)
    const off = await runJs(script)
    expect(off.isError).toBe(true)
    expect(off.text).toContain('unknown MCP server fake')
  })
})
