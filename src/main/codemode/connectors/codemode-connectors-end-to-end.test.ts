import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BotToolServer } from '../../../shared/bot-tools'
import { settleBotToolRevocations } from '../../bots/tool-oauth/bot-tool-oauth-revoke'
import { formBody } from '../../bots/tool-oauth/testing/fake-oauth-app'
import { FakeOAuthMcpServer } from '../../bots/tool-oauth/testing/fake-oauth-mcp-server'
import { BotToolRelay } from '../../bots/tool-relay/bot-tool-relay'
import { call, json } from '../../bots/tool-relay/bot-tool-relay.test-fixtures'
import { CodemodeService } from '../codemode-service'
import { CodemodeConnectorPool } from './codemode-connector-pool'
import { setUpConnectorTestEnv, signInConnector } from './testing/codemode-connector-test-env'

let bundleRoot: string
let workerPath: string
let fake: FakeOAuthMcpServer | null = null
let service: CodemodeService | null = null
let pool: CodemodeConnectorPool | null = null
let relay: BotToolRelay | null = null
const clients: Client[] = []

beforeAll(async () => {
  const cacheRoot = resolve('node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  bundleRoot = mkdtempSync(join(cacheRoot, 'orca-codemode-connectors-e2e-'))
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

const env = setUpConnectorTestEnv(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await service?.stop()
  service = null
  pool = null
  relay?.close()
  relay = null
  await fake?.stop()
  fake = null
})

const ECHO_OK = "return await mcp.fake.echo({ text: 'ok' })"
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'a', v: '1' } }
})

type Chat = {
  /** The agent's connection to the chat's `orca` server. */
  orca: Client
  /** The connector entry `launchServer` handed the chat for direct use. */
  direct: { url: string; authorization: string }
}

/** The fake OAuth MCP server, added and signed in the way a user would, served by the service. */
async function setUp(): Promise<string> {
  const { store, auth } = env.current()
  fake = await FakeOAuthMcpServer.start()
  const connector = await auth.add({ url: fake.mcpUrl, name: 'fake' })
  expect(connector.auth).toBe('oauth')
  await signInConnector(auth, connector.id, fake)
  expect(auth.status(connector.id)).toBe('connected')
  relay = new BotToolRelay((url, init) => fetch(url, init))
  pool = new CodemodeConnectorPool(store, auth)
  const opened = { store, auth, pool }
  service = new CodemodeService({
    workerPath,
    log: () => {},
    relay,
    connectors: async () => opened
  })
  return connector.id
}

function httpEntry(server: BotToolServer | undefined): { url: string; authorization: string } {
  if (!server || !('url' in server) || !server.headers?.authorization) {
    throw new Error('expected an http server with a bearer token')
  }
  return { url: server.url, authorization: server.headers.authorization }
}

async function agent(entry: { url: string; authorization: string }): Promise<Client> {
  const client = new Client({ name: 'agent', version: '1.0.0' })
  clients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: { authorization: entry.authorization } }
    })
  )
  return client
}

/** Launches a chat as Orca does and connects its agent to the `orca` server. */
async function launch(sessionId: string, id: string): Promise<Chat> {
  const servers = await service!.launchServer({
    sessionId,
    launchId: `launch-${sessionId}`,
    root: env.current().dir,
    env: process.env,
    mode: () => 'full-access'
  })
  expect(servers?.map((server) => server.name)).toEqual(['orca', 'fake'])
  const orcaEntry = httpEntry(servers?.[0])
  const direct = httpEntry(servers?.[1])
  expect(direct.url).toBe(`${await service!.relayOrigin()}/c/${id}/mcp`)
  expect(direct.authorization).toBe(orcaEntry.authorization)
  return { orca: await agent(orcaEntry), direct }
}

async function runJs(chat: Chat, code: string): Promise<{ text: string; isError: boolean }> {
  const result = await chat.orca.callTool({ name: 'run_js', arguments: { code } })
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
  return { text, isError: result.isError === true }
}

async function expectRunJsOk(chat: Chat): Promise<void> {
  const result = await runJs(chat, ECHO_OK)
  expect(result.isError).toBe(false)
  expect(result.text.split('\n')[0]).toBe('=> "ok"')
}

async function expectDirectEchoOk(client: Client): Promise<void> {
  const echoed = await client.callTool({ name: 'echo', arguments: { text: 'ok' } })
  expect(echoed.content).toEqual([{ type: 'text', text: 'ok' }])
}

/** A fresh `initialize` on the chat's direct entry, as a newly started agent would send it. */
const initialize = (chat: Chat) =>
  call(chat.direct.url, {
    headers: { ...json, authorization: chat.direct.authorization },
    body: INITIALIZE
  })

describe('connectors end to end', () => {
  it('serves one signed-in connector through run_js and directly, across a token expiry', async () => {
    const id = await setUp()
    const a = await launch('a', id)
    const b = await launch('b', id)

    await expectRunJsOk(a)
    await expectRunJsOk(b)
    expect(fake!.counts().mcpSessions).toBe(1)
    expect(pool!.sessionCount(id)).toBe(1)

    const direct = await agent(a.direct)
    const { tools } = await direct.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['count', 'echo', 'whoami'])
    await expectDirectEchoOk(direct)

    fake!.expireAccessTokens()
    await expectRunJsOk(a)
    await expectDirectEchoOk(direct)
    expect(fake!.counts().refreshes).toBeGreaterThanOrEqual(1)
  })

  it('refuses a connector in both paths once the chat switches it off, and only for that chat', async () => {
    const id = await setUp()
    const a = await launch('a', id)
    const b = await launch('b', id)
    await expectRunJsOk(a)

    await service!.setConnectorOff('a', id, true)

    const refused = await runJs(a, ECHO_OK)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('unknown MCP server fake')
    const answer = await initialize(a)
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({ error: 'connector fake is off for this chat' })

    await expectRunJsOk(b)
    await expectDirectEchoOk(await agent(b.direct))
  })

  it('fails both paths after the connector is removed and revokes its sign-in', async () => {
    const id = await setUp()
    const chat = await launch('a', id)
    await expectRunJsOk(chat)
    const direct = await agent(chat.direct)
    await expectDirectEchoOk(direct)

    const issued = new Set([...fake!.accessTokens, ...fake!.refreshTokens])
    await env.current().auth.remove(id)
    await settleBotToolRevocations()

    const revoked = fake!.hitsTo('/revoke').map((hit) => formBody(hit.body).get('token'))
    expect(revoked.length).toBeGreaterThan(0)
    expect(revoked.every((token) => token && issued.has(token))).toBe(true)
    const gone = await runJs(chat, ECHO_OK)
    expect(gone.isError).toBe(true)
    expect(gone.text).toContain('unknown MCP server fake')
    await expect(
      direct.callTool({ name: 'echo', arguments: { text: 'ok' } }, undefined, { timeout: 2000 })
    ).rejects.toThrow()
    const answer = await initialize(chat)
    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body)).toEqual({ error: 'unknown connector' })
  })
})
