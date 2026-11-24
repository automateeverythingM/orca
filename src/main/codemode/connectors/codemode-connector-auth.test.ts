import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../shared/secure-storage/secret-store'
import {
  readBotToolCredential,
  readBotToolOAuth,
  useBotToolCredentialsRoot
} from '../../bots/bot-tool-credentials'
import { settleBotToolRevocations } from '../../bots/tool-oauth/bot-tool-oauth-revoke'
import { setBotToolSignInBrowser } from '../../bots/tool-oauth/bot-tool-sign-in-flows'
import { FakeOAuthMcpServer } from '../../bots/tool-oauth/testing/fake-oauth-mcp-server'
import { CodemodeConnectorAuth, defaultConnectorName } from './codemode-connector-auth'
import {
  CODEMODE_CONNECTOR_CREDENTIAL_FOLDER,
  CodemodeConnectorStore
} from './codemode-connector-store'

let dir: string
let storePath: string
let store: CodemodeConnectorStore
let auth: CodemodeConnectorAuth
let fake: FakeOAuthMcpServer | null = null
let plain: Server | null = null

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'codemode-connector-auth-'))
  useBotToolCredentialsRoot(join(dir, 'credentials'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/s, '$1'),
    describeProtectionGap: () => null
  })
  storePath = join(dir, 'codemode-connectors.json')
  store = await CodemodeConnectorStore.open(storePath)
  auth = new CodemodeConnectorAuth(store)
})

afterEach(async () => {
  await settleBotToolRevocations()
  setBotToolSignInBrowser(null)
  await fake?.stop()
  fake = null
  plain?.closeAllConnections()
  plain?.close()
  plain = null
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

/** An MCP address that refuses without naming any sign-in Orca can run: a pasted token. */
async function startTokenServer(): Promise<string> {
  plain = createServer((req, res) => {
    res.writeHead(req.url?.startsWith('/mcp') ? 401 : 404, { 'content-type': 'text/plain' })
    res.end('no')
  })
  await new Promise<void>((resolve) => plain!.listen(0, '127.0.0.1', resolve))
  const address = plain.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`
}

async function signIn(id: string, server: FakeOAuthMcpServer): Promise<void> {
  setBotToolSignInBrowser((url) => server.approve(url))
  await auth.startSignIn(id)
  await expect.poll(() => auth.signInProgress(id).state).toBe('done')
}

async function signedIn(): Promise<{ id: string; server: FakeOAuthMcpServer }> {
  const server = await FakeOAuthMcpServer.start()
  fake = server
  const connector = await auth.add({ url: server.mcpUrl })
  await signIn(connector.id, server)
  return { id: connector.id, server }
}

describe('CodemodeConnectorAuth', () => {
  it('adds an OAuth server signed out, then signs in through the browser', async () => {
    fake = await FakeOAuthMcpServer.start()
    const connector = await auth.add({ url: fake.mcpUrl })
    expect(connector).toMatchObject({ name: 'local', auth: 'oauth', url: fake.mcpUrl })
    expect(auth.status(connector.id)).toBe('sign-in-needed')
    expect(auth.key(connector.id)).toEqual({
      folder: CODEMODE_CONNECTOR_CREDENTIAL_FOLDER,
      credentialId: connector.id
    })
    expect(readBotToolOAuth(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, connector.id)?.url).toBe(
      fake.mcpUrl
    )

    await signIn(connector.id, fake)
    expect(auth.status(connector.id)).toBe('connected')
  })

  it('adds a server that needs no sign-in as connected', async () => {
    fake = await FakeOAuthMcpServer.start({ requireAuth: false })
    const connector = await auth.add({ url: fake.mcpUrl, name: 'open' })
    expect(connector).toMatchObject({ name: 'open', auth: 'none' })
    expect(auth.status(connector.id)).toBe('connected')
  })

  it('needs a token for a server without a usable sign-in, and stores it as a bearer', async () => {
    const url = await startTokenServer()
    const connector = await auth.add({ url })
    expect(connector.auth).toBe('token')
    expect(auth.status(connector.id)).toBe('token-needed')
    auth.setToken(connector.id, 'pasted-secret-123')
    expect(auth.status(connector.id)).toBe('connected')
    expect(readBotToolCredential(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, connector.id)).toEqual({
      url,
      headers: { authorization: 'Bearer pasted-secret-123' }
    })
    expect(() => auth.setToken(connector.id, 'two\nlines')).toThrow()
    expect(() => auth.setToken(connector.id, '  ')).toThrow()
  })

  it('never writes a token into the connector list', async () => {
    const { id } = await signedIn()
    const access = readBotToolOAuth(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, id)?.record.tokens
    expect(access?.access_token).toBeTruthy()
    const tokenConnector = await auth.add({ url: await startTokenServer() })
    auth.setToken(tokenConnector.id, 'pasted-secret-456')
    const text = readFileSync(storePath, 'utf8')
    expect(text).toContain(id)
    expect(text).not.toContain(access!.access_token)
    expect(text).not.toContain(access!.refresh_token!)
    expect(text).not.toContain('pasted-secret-456')
  })

  it('removes a signed-in connector: revoked, forgotten, gone from the store', async () => {
    const { id, server } = await signedIn()
    await auth.remove(id)
    await settleBotToolRevocations()
    expect(server.hitsTo('/revoke').length).toBeGreaterThan(0)
    expect(readBotToolOAuth(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, id)).toBeNull()
    expect(store.get(id)).toBeNull()
  })

  it('removes a token connector and forgets its token', async () => {
    const connector = await auth.add({ url: await startTokenServer() })
    auth.setToken(connector.id, 'pasted-secret-789')
    await auth.remove(connector.id)
    expect(readBotToolCredential(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, connector.id)).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('refuses an address it already has or cannot reach', async () => {
    fake = await FakeOAuthMcpServer.start({ requireAuth: false })
    await auth.add({ url: fake.mcpUrl })
    await expect(auth.add({ url: fake.mcpUrl })).rejects.toThrow(
      `connector already added: ${fake.mcpUrl}`
    )
    const dead = 'http://127.0.0.1:9/mcp'
    await expect(auth.add({ url: dead })).rejects.toThrow(`could not reach ${dead}`)
    expect(store.list()).toHaveLength(1)
  })
})

describe('defaultConnectorName', () => {
  it('takes the host label and avoids names in use', () => {
    expect(defaultConnectorName('https://mcp.linear.app/mcp', [])).toBe('linear')
    expect(defaultConnectorName('https://api.github.com/mcp', [])).toBe('github')
    expect(defaultConnectorName('https://www.notion.so/mcp', [])).toBe('notion')
    expect(defaultConnectorName('https://mcp.example.co.uk/mcp', [])).toBe('example')
    expect(defaultConnectorName('http://127.0.0.1:9/mcp', [])).toBe('local')
    expect(defaultConnectorName('https://1password.com/mcp', [])).toBe('mcp-1password')
    expect(defaultConnectorName('https://mcp.linear.app/mcp', ['linear', 'linear-2'])).toBe(
      'linear-3'
    )
    expect(defaultConnectorName('https://orca.dev/mcp', [])).toBe('orca-2')
    const long = defaultConnectorName(`https://${'a'.repeat(60)}.com/mcp`, ['a'.repeat(40)])
    expect(long).toMatch(/^a+-2$/)
    expect(long).toHaveLength(40)
  })
})
