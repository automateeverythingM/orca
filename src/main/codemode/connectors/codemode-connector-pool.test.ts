import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { FakeOAuthMcpServer } from '../../bots/tool-oauth/testing/fake-oauth-mcp-server'
import { connectorFetch } from './codemode-connector-fetch'
import { CodemodeConnectorPool } from './codemode-connector-pool'
import { CodemodeConnectorStore } from './codemode-connector-store'
import { signInConnector, setUpConnectorTestEnv } from './testing/codemode-connector-test-env'

let fake: FakeOAuthMcpServer | null = null
let pool: CodemodeConnectorPool | null = null
let witness: Server | null = null
let release: (() => void) | null = null

const env = setUpConnectorTestEnv(async () => {
  release?.()
  release = null
  await pool?.closeAll()
  pool = null
  await fake?.stop()
  fake = null
  witness?.closeAllConnections()
  witness?.close()
  witness = null
})

const signal = (): AbortSignal => new AbortController().signal

async function signedInPool(): Promise<{ id: string; server: FakeOAuthMcpServer }> {
  const { store, auth } = env.current()
  const server = await FakeOAuthMcpServer.start()
  fake = server
  const connector = await auth.add({ url: server.mcpUrl })
  await signInConnector(auth, connector.id, server)
  pool = new CodemodeConnectorPool(store, auth)
  return { id: connector.id, server }
}

/** A server that only counts what reaches it: proof that nothing was sent there. */
async function startWitness(): Promise<{ url: string; hits: () => number }> {
  let hits = 0
  witness = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>((resolve) => witness!.listen(0, '127.0.0.1', resolve))
  const address = witness.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}/x`, hits: () => hits }
}

describe('CodemodeConnectorPool', () => {
  it('shares one upstream session between callers', async () => {
    const { id, server } = await signedInPool()
    const [echoed, tools] = await Promise.all([
      pool!.call(id, 'echo', { text: 'hi' }, signal()),
      pool!.describe(id),
      pool!.call(id, 'count', {}, signal())
    ])
    expect(echoed.text).toBe('hi')
    expect(tools.map((tool) => tool.name).sort()).toEqual(['count', 'echo', 'whoami'])
    expect(server.counts().mcpSessions).toBe(1)
    expect(pool!.sessionCount(id)).toBe(1)
  })

  it('passes structured content through', async () => {
    const { id } = await signedInPool()
    await expect(pool!.call(id, 'whoami', {}, signal())).resolves.toEqual({
      text: 'fake',
      structured: { user: 'fake' }
    })
  })

  it('refreshes once when the access token expired, and the call succeeds', async () => {
    const { id, server } = await signedInPool()
    await pool!.call(id, 'count', {}, signal())
    server.expireAccessTokens()
    await expect(pool!.call(id, 'echo', { text: 'again' }, signal())).resolves.toEqual({
      text: 'again'
    })
    expect(server.counts().refreshes).toBe(1)
  })

  it('asks for sign-in, quickly, when the sign-in was revoked', async () => {
    const { id, server } = await signedInPool()
    await pool!.call(id, 'count', {}, signal())
    server.revokeAll()
    server.expireAccessTokens()
    // A hang would end in the 2 s abort instead of the sign-in error.
    await expect(pool!.call(id, 'count', {}, AbortSignal.timeout(2000))).rejects.toThrow(
      'connector local needs sign-in'
    )
    expect(server.counts().refreshes).toBe(1)
  })

  it('refuses to follow a redirect, and the target sees nothing', async () => {
    const { id, server } = await signedInPool()
    await pool!.call(id, 'count', {}, signal())
    const target = await startWitness()
    server.redirectMcpTo(target.url)
    await expect(pool!.call(id, 'count', {}, signal())).rejects.toThrow(
      'connector local redirected; refusing to follow'
    )
    await pool!.closeAll()
    pool = new CodemodeConnectorPool(env.current().store, env.current().auth)
    await expect(pool.describe(id)).rejects.toThrow(
      'connector local redirected; refusing to follow'
    )
    expect(target.hits()).toBe(0)
  })

  it('drops the cached tool list when the server says it changed', async () => {
    const { id, server } = await signedInPool()
    expect(await pool!.describe(id)).toHaveLength(3)
    // The change arrives on the client's standing GET stream; wait until it is open.
    await expect
      .poll(() => server.hitsTo('/mcp').filter((hit) => hit.method === 'GET').length)
      .toBeGreaterThan(0)
    server.setTools(['echo'])
    await expect
      .poll(async () => (await pool!.describe(id)).map((tool) => tool.name))
      .toEqual(['echo'])
  })

  it('fails an in-flight call and closes the client when the connector is removed', async () => {
    const { id, server } = await signedInPool()
    await pool!.describe(id)
    release = server.holdCalls()
    const pending = pool!.call(id, 'count', {}, signal())
    await expect.poll(() => server.counts().calls).toBe(1)
    env.current().store.remove(id)
    await expect(pending).rejects.toThrow()
    expect(pool!.sessionCount(id)).toBe(0)
    await expect(pool!.call(id, 'count', {}, signal())).rejects.toThrow(`unknown connector: ${id}`)
  })

  it('keeps the client across a rename and closes it when the connector is turned off', async () => {
    const { id, server } = await signedInPool()
    const { store } = env.current()
    await pool!.call(id, 'count', {}, signal())
    store.update(id, { name: 'renamed' })
    expect(pool!.sessionCount(id)).toBe(1)
    await pool!.call(id, 'count', {}, signal())
    expect(server.counts().mcpSessions).toBe(1)
    store.update(id, { enabled: false })
    expect(pool!.sessionCount(id)).toBe(0)
    await expect(pool!.call(id, 'count', {}, signal())).rejects.toThrow(
      'connector renamed is turned off'
    )
  })

  it('sends a pasted token and never refreshes it', async () => {
    const { store, auth } = env.current()
    fake = await FakeOAuthMcpServer.start()
    const connector = store.add({ name: 'pasted', url: fake.mcpUrl, auth: 'token' })
    fake.accessTokens.add('pasted-good')
    auth.setToken(connector.id, 'pasted-good')
    pool = new CodemodeConnectorPool(store, auth)
    await expect(pool.call(connector.id, 'echo', { text: 'ok' }, signal())).resolves.toEqual({
      text: 'ok'
    })
    fake.expireAccessTokens()
    await expect(pool.call(connector.id, 'count', {}, signal())).rejects.toThrow(
      'connector pasted needs sign-in'
    )
    expect(fake.counts().tokenRequests).toBe(0)
  })
})

describe('connectorFetch', () => {
  it('sends a credential only to its own https origin', async () => {
    const { dir, auth } = env.current()
    const target = await startWitness()
    const path = `${dir}/hand-edited.json`
    const edited = { id: 'AAAAAAAAAAAAAAAA', name: 'plain', auth: 'none', trusted: false }
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        connectors: [{ ...edited, url: 'http://192.0.2.1/mcp', enabled: true }]
      })
    )
    const handEdited = await CodemodeConnectorStore.open(path)
    await expect(
      connectorFetch(edited.id, handEdited, auth)('http://192.0.2.1/mcp')
    ).rejects.toThrow('connector plain must use https')

    const local = env
      .current()
      .store.add({ name: 'local', url: `${target.url}/mcp`, auth: 'token' })
    auth.setToken(local.id, 'secret-for-local')
    const otherOrigin = target.url.replace('127.0.0.1', 'localhost')
    await expect(connectorFetch(local.id, env.current().store, auth)(otherOrigin)).rejects.toThrow(
      'connector local may only call'
    )
    expect(target.hits()).toBe(0)
  })
})
