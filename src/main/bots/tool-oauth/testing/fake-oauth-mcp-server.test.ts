import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { FakeOAuthMcpServer } from './fake-oauth-mcp-server'

let fake: FakeOAuthMcpServer | null = null

afterEach(async () => {
  await fake?.stop()
  fake = null
})

async function listenForCallback(): Promise<{
  redirect: string
  received: Promise<{ code: string; state: string }>
}> {
  let resolve!: (value: { code: string; state: string }) => void
  const received = new Promise<{ code: string; state: string }>((r) => (resolve = r))
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1')
    res.end('ok')
    http.close()
    resolve({
      code: url.searchParams.get('code') ?? '',
      state: url.searchParams.get('state') ?? ''
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { redirect: `http://127.0.0.1:${port}/callback`, received }
}

async function signIn(server: FakeOAuthMcpServer): Promise<{ access: string; refresh: string }> {
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${server.base}/authorize`)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'orca-client',
    redirect_uri: 'unused',
    state: 'abc',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  }).toString()
  const callback = await listenForCallback()
  authorize.searchParams.set('redirect_uri', callback.redirect)
  await server.approve(authorize.toString())
  const { code, state } = await callback.received
  expect(state).toBe('abc')
  const res = await fetch(`${server.base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: callback.redirect
    })
  })
  const token = (await res.json()) as { access_token: string; refresh_token: string }
  return { access: token.access_token, refresh: token.refresh_token }
}

async function connect(server: FakeOAuthMcpServer, access: string): Promise<Client> {
  const client = new Client({ name: 'fixture-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${access}` } }
    })
  )
  return client
}

describe('FakeOAuthMcpServer', () => {
  it('signs in and lists its three tools through the SDK client', async () => {
    fake = await FakeOAuthMcpServer.start()
    const { access } = await signIn(fake)
    const client = await connect(fake, access)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['count', 'echo', 'whoami'])
    const echoed = await client.callTool({ name: 'echo', arguments: { text: 'hi' } })
    expect(echoed.content).toEqual([{ type: 'text', text: 'hi' }])
    const who = await client.callTool({ name: 'whoami', arguments: {} })
    expect(who.structuredContent).toEqual({ user: 'fake' })
    expect(fake.counts().mcpSessions).toBe(1)
    expect(fake.counts().calls).toBe(2)
    await client.close()
  })

  it('answers 401 without a valid token and after expireAccessTokens', async () => {
    fake = await FakeOAuthMcpServer.start()
    const unauthenticated = await fetch(fake.mcpUrl, { method: 'POST' })
    expect(unauthenticated.status).toBe(401)
    const { access } = await signIn(fake)
    fake.expireAccessTokens()
    await expect(connect(fake, access)).rejects.toThrow()
    const res = await fetch(fake.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}` }
    })
    expect(res.status).toBe(401)
  })

  it('fails a refresh with invalid_grant after revokeAll', async () => {
    fake = await FakeOAuthMcpServer.start()
    const { refresh } = await signIn(fake)
    fake.revokeAll()
    const res = await fetch(`${fake.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh })
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_grant' })
    expect(fake.counts().refreshes).toBe(1)
  })

  it('redirects /mcp and announces tools/list_changed', async () => {
    fake = await FakeOAuthMcpServer.start()
    fake.redirectMcpTo('http://example.invalid/elsewhere')
    const res = await fetch(fake.mcpUrl, { method: 'POST', redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://example.invalid/elsewhere')
    fake.redirectMcpTo(null)
    const { access } = await signIn(fake)
    const client = await connect(fake, access)
    let changed = 0
    client.setNotificationHandler(
      (await import('@modelcontextprotocol/sdk/types.js')).ToolListChangedNotificationSchema,
      () => {
        changed += 1
      }
    )
    await expect.poll(() => fake!.hitsTo('/mcp').some((hit) => hit.method === 'GET')).toBe(true)
    fake.setTools(['echo'])
    await expect.poll(() => changed).toBeGreaterThan(0)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo'])
    await client.close()
  })
})
