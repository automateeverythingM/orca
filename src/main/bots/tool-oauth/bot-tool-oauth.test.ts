import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../shared/secure-storage/secret-store'
import {
  botToolCredentialsFingerprint,
  botToolCredentialsPath,
  readBotToolOAuth,
  useBotToolCredentialsRoot
} from '../bot-tool-credentials'
import { changeBotToolServers, readBotToolServers, writeBotToolServers } from '../bot-tools-file'
import { setBotToolOAuthDeps, type BotToolOAuthKey } from './bot-tool-oauth'
import { beginBotToolSignIn, createBotToolSignIn } from './bot-tool-oauth-sign-in'
import {
  botToolAccessToken,
  botToolSignInState,
  refreshBotToolAccessToken
} from './bot-tool-oauth-tokens'
import { settleBotToolRevocations, signOutBotTool } from './bot-tool-oauth-revoke'
import { discoverBotToolAuth } from './bot-tool-oauth-discovery'
import { OAuthFetchRefused, secureOAuthFetch } from './secure-oauth-fetch'
import { FakeOAuthApp, type Hit } from './testing/fake-oauth-app'

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

let app: FakeOAuthApp
let clock = 1_000_000
let key: BotToolOAuthKey
const REDIRECT = 'http://127.0.0.1:43210/callback'

beforeEach(async () => {
  useBotToolCredentialsRoot(tempDir('bot-tool-oauth-store-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/s, '$1'),
    describeProtectionGap: () => null
  })
  clock = 1_000_000
  setBotToolOAuthDeps({ now: () => clock })
  app = new FakeOAuthApp()
  await app.start()
  key = { folder: tempDir('bot-home-'), credentialId: 'cred-0001' }
  await createBotToolSignIn(key, app.url)
})

afterEach(async () => {
  await settleBotToolRevocations()
  app.server.closeAllConnections()
  app.server.close()
  setBotToolOAuthDeps({})
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function signIn(): Promise<void> {
  const attempt = await beginBotToolSignIn(key, { redirectUri: REDIRECT })
  await attempt.complete({ code: app.grantCode(attempt.authorizationUrl), iss: app.base })
}

const stored = () => readBotToolOAuth(key.folder, key.credentialId)

describe('Orca signing in to a bot’s app', () => {
  it('registers as Orca and signs in with PKCE, the exact resource and offline access', async () => {
    const attempt = await beginBotToolSignIn(key, { redirectUri: REDIRECT })

    expect(app.hitsTo('/register')[0]!.body).toMatchObject({
      client_name: 'Orca',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none'
    })
    const url = new URL(attempt.authorizationUrl)
    expect(url.origin + url.pathname).toBe(`${app.base}/authorize`)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('resource')).toBe(app.url)
    expect(url.searchParams.get('scope')).toBe('read offline_access')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(url.searchParams.get('state')).toBe(attempt.state)
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out' })

    await attempt.complete({ code: app.grantCode(attempt.authorizationUrl), iss: app.base })

    const exchange = form(app.hitsTo('/token')[0]!.body)
    expect(exchange.get('resource')).toBe(app.url)
    expect(exchange.get('redirect_uri')).toBe(REDIRECT)
    expect(exchange.get('client_id')).toBe('orca-client')
    expect(botToolSignInState(key)).toEqual({ state: 'signed-in', limited: false })
    expect(await botToolAccessToken(key)).toEqual({ token: 'access-1', grant: 1 })
    // The sealed file never holds a token in the clear.
    expect(readFileSync(botToolCredentialsPath(key.folder), 'utf8')).not.toContain('"access-1"')
  })

  it('refuses a return from another issuer, a second use and an expired attempt', async () => {
    const wrongIssuer = await beginBotToolSignIn(key, { redirectUri: REDIRECT })
    await expect(
      wrongIssuer.complete({
        code: app.grantCode(wrongIssuer.authorizationUrl),
        iss: 'https://evil.example'
      })
    ).rejects.toMatchObject({ code: 'issuer-mismatch' })
    await expect(wrongIssuer.complete({ code: 'code-x', iss: app.base })).rejects.toMatchObject({
      code: 'superseded'
    })

    const missingIss = await beginBotToolSignIn(key, { redirectUri: REDIRECT })
    await expect(missingIss.complete({ code: 'code-y' })).rejects.toMatchObject({
      code: 'issuer-mismatch'
    })

    const late = await beginBotToolSignIn(key, { redirectUri: REDIRECT })
    clock += 5 * 60_000 + 1
    await expect(
      late.complete({ code: app.grantCode(late.authorizationUrl), iss: app.base })
    ).rejects.toMatchObject({ code: 'expired' })
    expect(app.hitsTo('/token')).toHaveLength(0)
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out' })
  })

  it('ignores a return with another state, and ends on a denial read only after the state', async () => {
    const attempt = await beginBotToolSignIn(key, { redirectUri: REDIRECT })
    const code = app.grantCode(attempt.authorizationUrl)
    expect(attempt.owns(new URLSearchParams({ state: 'forged', error: 'access_denied' }))).toBe(
      false
    )
    expect(
      attempt.owns(
        new URLSearchParams([
          ['state', attempt.state],
          ['state', attempt.state]
        ])
      )
    ).toBe(false)

    // A mangled return of its own spends nothing: the real one still finishes.
    for (const mangled of [
      [
        ['state', attempt.state],
        ['code', code],
        ['code', 'other']
      ],
      [
        ['state', attempt.state],
        ['code', code],
        ['iss', app.base],
        ['iss', app.base]
      ],
      [
        ['state', attempt.state],
        ['code', code],
        ['error', 'access_denied']
      ],
      [['state', attempt.state]]
    ]) {
      await expect(
        attempt.completeFromCallback(new URLSearchParams(mangled))
      ).rejects.toMatchObject({ code: 'superseded' })
    }
    expect(app.hitsTo('/token')).toHaveLength(0)

    await attempt.completeFromCallback(
      new URLSearchParams({ state: attempt.state, code, iss: app.base })
    )
    expect(botToolSignInState(key)).toEqual({ state: 'signed-in', limited: false })

    const denied = await beginBotToolSignIn(key, { redirectUri: REDIRECT })
    await expect(
      denied.completeFromCallback(
        new URLSearchParams({ state: denied.state, error: 'access_denied' })
      )
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('shares one refresh between calls refused together and stores the rotated token first', async () => {
    await signIn()
    const fingerprint = botToolCredentialsFingerprint(key.folder, new Set([key.credentialId]))

    const answers = await Promise.all(
      Array.from({ length: 5 }, () => refreshBotToolAccessToken(key, 'access-1'))
    )

    expect(answers).toEqual(Array.from({ length: 5 }, () => ({ token: 'access-2', grant: 1 })))
    const refreshes = app
      .hitsTo('/token')
      .filter((hit) => form(hit.body).get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(form(refreshes[0]!.body).get('refresh_token')).toBe('refresh-1')
    expect(form(refreshes[0]!.body).get('resource')).toBe(app.url)
    expect(stored()?.record.tokens).toMatchObject({
      access_token: 'access-2',
      refresh_token: 'refresh-2'
    })
    // A refresh is not a new sign-in: no chat restarts and no editor goes stale.
    expect(botToolCredentialsFingerprint(key.folder, new Set([key.credentialId]))).toBe(fingerprint)
  })

  it('keeps the refresh token when the app sends none, and refreshes ahead of expiry', async () => {
    await signIn()
    app.rotate = false
    clock += 3600_000 - 30_000
    expect(await botToolAccessToken(key)).toEqual({ token: 'access-2', grant: 1 })
    expect(stored()?.record.tokens?.refresh_token).toBe('refresh-1')
  })

  it('drops the tokens when the app ends the grant, and keeps them on a server error', async () => {
    await signIn()
    app.tokenAnswer = async () => [503, { error: 'temporarily_unavailable' }]
    expect(await refreshBotToolAccessToken(key, 'access-1')).toBeNull()
    expect(botToolSignInState(key)).toEqual({ state: 'signed-in', limited: false })

    app.tokenAnswer = async () => [400, { error: 'invalid_grant' }]
    expect(await refreshBotToolAccessToken(key, 'access-1')).toBeNull()
    expect(botToolSignInState(key)).toEqual({ state: 'lost' })
    expect(stored()?.record.client).toMatchObject({ client_id: 'orca-client' })
  })

  it('lets no refresh that finishes after a sign-out bring the sign-in back', async () => {
    await signIn()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    app.tokenAnswer = async () => {
      await held
      return [
        200,
        { access_token: 'late-access', token_type: 'Bearer', refresh_token: 'late-refresh' }
      ]
    }
    const refreshing = refreshBotToolAccessToken(key, 'access-1')
    await vi.waitFor(() => expect(app.hitsTo('/token')).toHaveLength(2))

    await signOutBotTool(key)
    release()

    expect(await refreshing).toBeNull()
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out' })
    await settleBotToolRevocations()
    expect(revoked()).toEqual(
      expect.arrayContaining(['refresh-1', 'access-1', 'late-refresh', 'late-access'])
    )
  })

  it('revokes nothing a late refresh earned while a newer sign-in holds the same client', async () => {
    await signIn()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    app.tokenAnswer = async () => {
      await held
      return [
        200,
        { access_token: 'late-access', token_type: 'Bearer', refresh_token: 'late-refresh' }
      ]
    }
    const refreshing = refreshBotToolAccessToken(key, 'access-1')
    await vi.waitFor(() => expect(app.hitsTo('/token')).toHaveLength(2))

    await signIn()
    release()
    await refreshing
    await settleBotToolRevocations()

    expect(stored()?.record.tokens?.access_token).toBe('access-2')
    expect(revoked()).toEqual([])
  })

  it('gives every waiter a refresh that couldn’t be stored, never an unhandled failure', async () => {
    await signIn()
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('key store unavailable')
      },
      decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/s, '$1'),
      describeProtectionGap: () => null
    })
    const waiting = new AbortController()
    await expect(refreshBotToolAccessToken(key, 'access-1', waiting.signal)).rejects.toThrow(
      'key store unavailable'
    )
    expect(stored()?.record.tokens?.access_token).toBe('access-1')
  })

  it('adds a tool and its signed-out sign-in in one transaction', async () => {
    const folder = tempDir('bot-home-')
    await changeBotToolServers(
      folder,
      (servers) => [...servers, { name: 'app', url: app.url, credential: 'cred-0002' }],
      undefined,
      undefined,
      new Map([['cred-0002', { url: app.url, signIn: true as const }]])
    )
    expect(botToolSignInState({ folder, credentialId: 'cred-0002' })).toEqual({
      state: 'signed-out'
    })
  })

  it('adds neither the tool nor its sign-in when the sign-in can’t be stored', async () => {
    const folder = tempDir('bot-home-')
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('key store unavailable')
      },
      decryptString: (cipher) => cipher.toString('utf8'),
      describeProtectionGap: () => null
    })
    await expect(
      changeBotToolServers(
        folder,
        (servers) => [...servers, { name: 'app', url: app.url, credential: 'cred-0003' }],
        undefined,
        undefined,
        new Map([['cred-0003', { url: app.url, signIn: true as const }]])
      )
    ).rejects.toThrow('key store unavailable')
    expect(await readBotToolServers(folder)).toEqual([])
    expect(readBotToolOAuth(folder, 'cred-0003')).toBeNull()
  })

  it('lets no refusal that arrives after a newer sign-in drop it', async () => {
    await signIn()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    app.tokenAnswer = async () => {
      await held
      return [400, { error: 'invalid_grant' }]
    }
    const refreshing = refreshBotToolAccessToken(key, 'access-1')
    await vi.waitFor(() => expect(app.hitsTo('/token')).toHaveLength(2))

    await signIn()
    release()
    await refreshing

    expect(botToolSignInState(key)).toEqual({ state: 'signed-in', limited: false })
    expect(stored()?.grant).toBe(2)
  })

  it('revokes the refresh token, then the access token, when the tool is removed', async () => {
    await writeBotToolServers(key.folder, [
      { name: 'app', url: app.url, credential: key.credentialId }
    ])
    await signIn()

    await changeBotToolServers(key.folder, () => [])
    await settleBotToolRevocations()

    expect(stored()).toBeNull()
    expect(revoked()).toEqual(['refresh-1', 'access-1'])
  })

  it('makes a new address a new sign-in and ends the old one', async () => {
    await writeBotToolServers(key.folder, [
      { name: 'app', url: app.url, credential: key.credentialId }
    ])
    await signIn()

    await changeBotToolServers(key.folder, () => [
      { name: 'app', url: `${app.base}/other`, credential: key.credentialId }
    ])
    await settleBotToolRevocations()

    expect(stored()).toBeNull()
    expect(revoked()).toEqual(['refresh-1', 'access-1'])
  })
})

describe('what an app’s address needs', () => {
  it('needs Orca’s sign-in when it challenges and offers registration', async () => {
    expect(await discoverBotToolAuth(app.url)).toMatchObject({
      kind: 'oauth',
      issuer: app.base,
      resource: app.url,
      scope: 'read'
    })
  })

  it('is unsupported without dynamic registration, and unavailable on a server error', async () => {
    delete app.metadata.registration_endpoint
    expect(await discoverBotToolAuth(app.url)).toEqual({ kind: 'unsupported' })
    const fetch = async () => new Response('busy', { status: 503 })
    expect(await discoverBotToolAuth(app.url, { fetch })).toEqual({ kind: 'unavailable' })
  })

  it('needs nothing only when an open answer is a real MCP initialize result', async () => {
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'x', version: '1' }
      }
    })
    const answering =
      (body: string, type: string) =>
      async (url: string | URL): Promise<Response> =>
        String(url).endsWith('/mcp')
          ? new Response(body, { status: 200, headers: { 'content-type': type } })
          : new Response('', { status: 404 })
    expect(
      await discoverBotToolAuth(app.url, { fetch: answering('{}', 'application/json') })
    ).toEqual({ kind: 'unavailable' })
    const incomplete = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: {} }
    })
    expect(
      await discoverBotToolAuth(app.url, { fetch: answering(incomplete, 'application/json') })
    ).toEqual({ kind: 'unavailable' })
    expect(
      await discoverBotToolAuth(app.url, { fetch: answering(initialize, 'application/json') })
    ).toEqual({ kind: 'none' })
    expect(
      await discoverBotToolAuth(app.url, {
        fetch: answering(`event: message\ndata: ${initialize}\n\n`, 'text/event-stream')
      })
    ).toEqual({ kind: 'none' })
  })

  it('trusts no authorization-server metadata that names another issuer', async () => {
    app.metadata.issuer = 'https://other.example'
    expect(await discoverBotToolAuth(app.url)).toEqual({ kind: 'unsupported' })
    // An exact match: a trailing slash names another issuer.
    app.metadata.issuer = `${app.base}/`
    expect(await discoverBotToolAuth(app.url)).toEqual({ kind: 'unsupported' })
  })
})

describe('the fetch every sign-in request goes through', () => {
  const lookup = async (host: string) =>
    host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']

  it('refuses plain http off this machine and a private endpoint for a public app', async () => {
    const fetch = async () => new Response('{}')
    const secure = secureOAuthFetch({ resource: 'https://app.example/mcp', lookup, fetch })
    await expect(secure('http://auth.example/token')).rejects.toMatchObject({ code: 'insecure' })
    await expect(secure('https://internal.example/token')).rejects.toMatchObject({
      code: 'private-endpoint'
    })
    expect(await (await secure('https://auth.example/token')).text()).toBe('{}')
  })

  it('refuses to carry a body to another origin, and too many redirects', async () => {
    const fetch = async (url: string | URL) =>
      new Response(null, {
        status: 307,
        headers: { location: String(url).includes('loop') ? '/loop' : 'https://other.example/x' }
      })
    const secure = secureOAuthFetch({ resource: 'https://app.example/mcp', lookup, fetch })
    await expect(
      secure('https://auth.example/token', { method: 'POST', body: 'code=1' })
    ).rejects.toMatchObject({
      code: 'redirect-origin'
    })
    await expect(secure('https://auth.example/loop')).rejects.toMatchObject({
      code: 'too-many-redirects'
    })
  })

  it('bounds an address lookup that never answers by the request deadline', async () => {
    const hangingLookup = () => new Promise<readonly string[]>(() => undefined)
    const fetch = async () => new Response('{}')
    await expect(
      secureOAuthFetch({
        resource: 'https://app.example/mcp',
        lookup: hangingLookup,
        fetch,
        deadlineMs: 20
      })('https://auth.example/token')
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('refuses an oversized body and an endpoint that never finishes', async () => {
    const big = async () => new Response(new Uint8Array(1024 * 1024 + 1))
    await expect(
      secureOAuthFetch({ resource: 'https://app.example/mcp', lookup, fetch: big })(
        'https://auth.example/m'
      )
    ).rejects.toBeInstanceOf(OAuthFetchRefused)
    const hang = (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      )
    await expect(
      secureOAuthFetch({
        resource: 'https://app.example/mcp',
        lookup,
        fetch: hang,
        deadlineMs: 20
      })('https://auth.example/m')
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})

function form(body: Hit['body']): URLSearchParams {
  if (!(body instanceof URLSearchParams)) {
    throw new Error('expected a form body')
  }
  return body
}

function revoked(): string[] {
  return app.hitsTo('/revoke').map((hit) => form(hit.body).get('token') ?? '')
}
