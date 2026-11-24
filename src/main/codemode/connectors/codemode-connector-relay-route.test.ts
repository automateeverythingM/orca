import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodemodeConnector } from '../../../shared/codemode/codemode-connector-types'
import { FakeOAuthMcpServer } from '../../bots/tool-oauth/testing/fake-oauth-mcp-server'
import { BotToolRelay } from '../../bots/tool-relay/bot-tool-relay'
import { call, json } from '../../bots/tool-relay/bot-tool-relay.test-fixtures'
import { CodemodeService } from '../codemode-service'
import { CodemodeConnectorPool } from './codemode-connector-pool'
import { signInConnector, setUpConnectorTestEnv } from './testing/codemode-connector-test-env'

let fake: FakeOAuthMcpServer | null = null
let service: CodemodeService | null = null
let relay: BotToolRelay | null = null
const clients: Client[] = []

const env = setUpConnectorTestEnv(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await service?.stop()
  service = null
  relay?.close()
  relay = null
  await fake?.stop()
  fake = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'a', v: '1' } }
})

/** A usable connector, the service and relay wired as the app wires them, and the relay origin. */
async function setUp(kind: 'oauth' | 'token' = 'oauth'): Promise<{ id: string; origin: string }> {
  const { store, auth } = env.current()
  fake = await FakeOAuthMcpServer.start()
  let connector: CodemodeConnector
  if (kind === 'oauth') {
    connector = await auth.add({ url: fake.mcpUrl, name: 'fake' })
    await signInConnector(auth, connector.id, fake)
  } else {
    connector = store.add({ name: 'fake', url: fake.mcpUrl, auth: 'token' })
    fake.accessTokens.add('pasted-token')
    auth.setToken(connector.id, 'pasted-token')
  }
  relay = new BotToolRelay((url, init) => fetch(url, init))
  service = new CodemodeService({
    log: () => {},
    relay,
    connectors: async () => ({ store, auth, pool: new CodemodeConnectorPool(store, auth) })
  })
  return { id: connector.id, origin: await service.relayOrigin() }
}

/** The chat's code-mode token, as its agent holds it. */
async function launch(sessionId: string, launchId = `launch-${sessionId}`): Promise<string> {
  const [server] = (await service!.launchServer({
    sessionId,
    launchId,
    root: env.current().dir,
    env: process.env,
    mode: () => 'full-access'
  })) ?? [null]
  const authorization = server && 'headers' in server ? server.headers?.authorization : undefined
  if (!authorization) {
    throw new Error('expected an http server with a bearer token')
  }
  return authorization.replace(/^Bearer /, '')
}

async function agent(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'agent', version: '1.0.0' })
  clients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
  )
  return client
}

/** Requests that reached the connector's MCP endpoint (sign-in discovery hits it too). */
const mcpPosts = (): number => fake!.hitsTo('/mcp').filter((hit) => hit.method === 'POST').length

const post = (url: string, token: string, extra: Record<string, string> = {}, body = INITIALIZE) =>
  call(url, { headers: { ...json, authorization: `Bearer ${token}`, ...extra }, body })

describe('relay route for direct connector access', () => {
  it("lists the connector's tools with the chat's token", async () => {
    const { id, origin } = await setUp()
    const token = await launch('s1')
    const client = await agent(`${origin}/c/${id}/mcp`, token)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['count', 'echo', 'whoami'])
  })

  it('keeps bot tokens and chat tokens on their own routes', async () => {
    const { id, origin } = await setUp()
    const token = await launch('s1')
    const bot = await relay!.grant('scout', env.current().dir)
    const before = mcpPosts()
    expect((await post(`${origin}/c/${id}/mcp`, bot.token)).status).toBe(401)
    expect((await post(`${origin}/bot-tools/${id}/mcp`, token)).status).toBe(401)
    expect(mcpPosts()).toBe(before)
  })

  it("refuses a connector a chat switched off while another chat's switch stays on", async () => {
    const { id, origin } = await setUp()
    const tokenA = await launch('a')
    const tokenB = await launch('b')
    await service!.setConnectorOff('a', id, true)
    const before = mcpPosts()
    const refused = await post(`${origin}/c/${id}/mcp`, tokenA)
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual({ error: 'connector fake is off for this chat' })
    expect(mcpPosts()).toBe(before)
    const client = await agent(`${origin}/c/${id}/mcp`, tokenB)
    expect((await client.listTools()).tools).toHaveLength(3)
  })

  it.each<'oauth' | 'token'>(['oauth', 'token'])(
    "never lets one chat's token ride another chat's upstream session (%s)",
    async (kind) => {
      const { id, origin } = await setUp(kind)
      const tokenA = await launch('a')
      const tokenB = await launch('b')
      const transport = new StreamableHTTPClientTransport(new URL(`${origin}/c/${id}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokenB}` } }
      })
      const clientB = new Client({ name: 'agent-b', version: '1.0.0' })
      clients.push(clientB)
      await clientB.connect(transport)
      const sessionOfB = transport.sessionId
      expect(sessionOfB).toBeTruthy()
      const before = mcpPosts()
      const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      const stolen = await post(
        `${origin}/c/${id}/mcp`,
        tokenA,
        { 'mcp-session-id': sessionOfB!, 'mcp-protocol-version': '2025-03-26' },
        list
      )
      expect(stolen.status).toBe(404)
      expect(mcpPosts()).toBe(before)
    }
  )

  it('answers 404 for an unknown or turned-off connector', async () => {
    const { id, origin } = await setUp()
    const token = await launch('s1')
    const before = mcpPosts()
    const unknown = await post(`${origin}/c/AAAAAAAAAAAAAAAA/mcp`, token)
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body)).toEqual({ error: 'unknown connector' })
    env.current().store.update(id, { enabled: false })
    const disabled = await post(`${origin}/c/${id}/mcp`, token)
    expect(disabled.status).toBe(404)
    expect(JSON.parse(disabled.body)).toEqual({ error: 'unknown connector' })
    expect(mcpPosts()).toBe(before)
  })

  it('refreshes an expired token once and the call goes through', async () => {
    const { id, origin } = await setUp()
    const client = await agent(`${origin}/c/${id}/mcp`, await launch('s1'))
    await client.callTool({ name: 'count', arguments: {} })
    fake!.expireAccessTokens()
    const echoed = await client.callTool({ name: 'echo', arguments: { text: 'again' } })
    expect(echoed.content).toEqual([{ type: 'text', text: 'again' }])
    expect(fake!.counts().refreshes).toBe(1)
  })

  it('asks for sign-in, without looping, once the sign-in was revoked', async () => {
    const { id, origin } = await setUp()
    const client = await agent(`${origin}/c/${id}/mcp`, await launch('s1'))
    await client.callTool({ name: 'count', arguments: {} })
    fake!.revokeAll()
    await expect(
      client.callTool({ name: 'count', arguments: {} }, undefined, { timeout: 2000 })
    ).rejects.toMatchObject({
      code: -32001,
      message: 'MCP error -32001: connector fake needs sign-in'
    })
    expect(fake!.counts().refreshes).toBe(1)
  })

  it('answers sign-in needed, not a bare 401, once a pasted token is refused', async () => {
    const { id, origin } = await setUp('token')
    const client = await agent(`${origin}/c/${id}/mcp`, await launch('s1'))
    await client.callTool({ name: 'count', arguments: {} })
    fake!.revokeAll()
    await expect(
      client.callTool({ name: 'count', arguments: {} }, undefined, { timeout: 2000 })
    ).rejects.toMatchObject({
      code: -32001,
      message: 'MCP error -32001: connector fake needs sign-in'
    })
  })

  it('answers unknown connector when it is removed after the chat was let through', async () => {
    const { id, origin } = await setUp()
    const token = await launch('s1')
    const { store } = env.current()
    // `allow` reads the switch last: a removal there lands between allow and the source.
    vi.spyOn(service!, 'connectorsOff').mockImplementation(() => {
      store.remove(id)
      return new Set()
    })
    const answer = await post(`${origin}/c/${id}/mcp`, token)
    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body)).toEqual({ error: 'unknown connector' })
  })

  it('refuses a chat that ended, and forgets its upstream sessions', async () => {
    const { id, origin } = await setUp()
    const token = await launch('s1')
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/c/${id}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
    const client = new Client({ name: 'agent', version: '1.0.0' })
    clients.push(client)
    await client.connect(transport)
    await service!.endSession('s1')
    expect((await post(`${origin}/c/${id}/mcp`, token)).status).toBe(401)
    // The same chat relaunched gets a new token, never the ended launch's upstream session.
    const again = await launch('s1')
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const headers = { 'mcp-session-id': transport.sessionId!, 'mcp-protocol-version': '2025-03-26' }
    expect((await post(`${origin}/c/${id}/mcp`, again, headers, list)).status).toBe(404)
  })

  it('ends the old launch’s relay sessions when the chat relaunches', async () => {
    const { id, origin } = await setUp()
    const token = await launch('s1', 'launch-1')
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/c/${id}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
    const old = new Client({ name: 'agent', version: '1.0.0' })
    clients.push(old)
    await old.connect(transport)
    const again = await launch('s1', 'launch-2')
    expect((await post(`${origin}/c/${id}/mcp`, token)).status).toBe(401)
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const headers = { 'mcp-session-id': transport.sessionId!, 'mcp-protocol-version': '2025-03-26' }
    expect((await post(`${origin}/c/${id}/mcp`, again, headers, list)).status).toBe(404)
    const fresh = await agent(`${origin}/c/${id}/mcp`, again)
    expect((await fresh.listTools()).tools).toHaveLength(3)
  })
})
