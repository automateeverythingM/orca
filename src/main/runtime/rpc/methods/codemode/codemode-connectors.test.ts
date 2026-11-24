import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { readBotToolOAuth } from '../../../../bots/bot-tool-credentials'
import { setBotToolSignInBrowser } from '../../../../bots/tool-oauth/bot-tool-sign-in-flows'
import { FakeOAuthMcpServer } from '../../../../bots/tool-oauth/testing/fake-oauth-mcp-server'
import { CodemodeService } from '../../../../codemode/codemode-service'
import { CodemodeConnectorPool } from '../../../../codemode/connectors/codemode-connector-pool'
import { CODEMODE_CONNECTOR_CREDENTIAL_FOLDER } from '../../../../codemode/connectors/codemode-connector-store'
import { setUpConnectorTestEnv } from '../../../../codemode/connectors/testing/codemode-connector-test-env'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { codemodeConnectorMethods, type CodemodeConnectorMethodDeps } from './codemode-connectors'

const PASTED = 'pasted-secret-rpc-789'

let fake: FakeOAuthMcpServer | null = null
let plain: Server | null = null
let service: CodemodeService | null = null

const env = setUpConnectorTestEnv(async () => {
  await service?.stop()
  service = null
  await fake?.stop()
  fake = null
  plain?.closeAllConnections()
  plain?.close()
  plain = null
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

function methodsFor(deps: Partial<CodemodeConnectorMethodDeps> = {}) {
  const { store, auth } = env.current()
  service = new CodemodeService({
    log: () => {},
    connectors: async () => ({ store, auth, pool: new CodemodeConnectorPool(store, auth) })
  })
  const opened = service
  const methods = codemodeConnectorMethods({
    desktop: () => true,
    service: async () => opened,
    sessionAccess: async () => {},
    search: async () => ({ entries: [] }),
    ...deps
  })
  const ctx: RpcContext = { runtime: new OrcaRuntimeService(null) }
  const call = async <N extends (typeof methods)[number]['name']>(
    name: N,
    params: unknown
  ): Promise<unknown> => {
    const method = eraseRpcMethods(methods).find((m) => m.name === name)
    if (!method) {
      throw new Error(`no method ${name}`)
    }
    // The dispatcher parses params before a handler runs; do the same here.
    return await method.handler(method.params?.parse(params), ctx)
  }
  return { methods, call }
}

describe('codemode.connectors.* RPC methods', () => {
  it('never return an access token, refresh token or pasted token', async () => {
    const { methods, call } = methodsFor()
    fake = await FakeOAuthMcpServer.start()
    const oauthServer = fake
    setBotToolSignInBrowser((url) => oauthServer.approve(url))
    const results: unknown[] = []
    const record = async (name: Parameters<typeof call>[0], params: unknown) => {
      const result = await call(name, params)
      results.push(result)
      return result
    }

    const added = await record('codemode.connectors.add', { url: fake.mcpUrl, name: 'crm' })
    const tokenAdded = await record('codemode.connectors.add', { url: await startTokenServer() })
    const oauthId = env.current().store.byName('crm')!.id
    const tokenId = env
      .current()
      .store.list()
      .find((c) => c.auth === 'token')!.id
    expect(added).toMatchObject({ connector: { name: 'crm', status: 'sign-in-needed' } })
    expect(tokenAdded).toMatchObject({ connector: { auth: 'token', status: 'token-needed' } })

    await record('codemode.connectors.signIn.start', { id: oauthId })
    await expect
      .poll(async () => {
        const progress = await record('codemode.connectors.signIn.status', { id: oauthId })
        return JSON.stringify(progress)
      })
      .toContain('"done"')
    await record('codemode.connectors.setToken', { id: tokenId, token: PASTED })

    const list = await record('codemode.connectors.list', undefined)
    expect(list).toMatchObject({
      connectors: [
        { id: oauthId, status: 'connected' },
        { id: tokenId, status: 'connected' }
      ]
    })
    await record('codemode.connectors.update', { id: oauthId, trusted: true })
    await record('codemode.connectors.session.toggle', { sessionId: 's1', id: tokenId, on: false })
    await record('codemode.connectors.update', { id: oauthId, enabled: false })
    expect(await record('codemode.connectors.session.list', { sessionId: 's1' })).toEqual({
      connectors: [
        { id: oauthId, name: 'crm', on: false, enabled: false, status: 'connected' },
        { id: tokenId, name: expect.any(String), on: false, enabled: true, status: 'connected' }
      ]
    })
    await record('codemode.connectors.signIn.cancel', { id: oauthId })
    await record('codemode.connectors.registry.search', { query: 'crm' })

    const saved = readBotToolOAuth(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, oauthId)?.record.tokens
    expect(saved?.access_token).toBeTruthy()
    expect(saved?.refresh_token).toBeTruthy()
    await record('codemode.connectors.remove', { id: tokenId })
    await record('codemode.connectors.remove', { id: oauthId })

    const failure = await call('codemode.connectors.setToken', { id: tokenId, token: PASTED }).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )
    expect(failure).toBe(`unknown connector: ${tokenId}`)

    // Every method answered at least once.
    expect(new Set(methods.map((m) => m.name)).size).toBe(11)
    const text = JSON.stringify(results) + failure
    expect(text).toContain(oauthId)
    expect(text).not.toContain(saved!.access_token)
    expect(text).not.toContain(saved!.refresh_token!)
    expect(text).not.toContain(PASTED)
    expect(text.toLowerCase()).not.toContain('bearer')
  })

  it('refuses every method outside the desktop app', async () => {
    const { methods, call } = methodsFor({ desktop: () => false })
    const id = 'abc'
    const params: Record<(typeof methods)[number]['name'], unknown> = {
      'codemode.connectors.list': undefined,
      'codemode.connectors.add': { url: 'https://example.com/mcp' },
      'codemode.connectors.update': { id, trusted: true },
      'codemode.connectors.remove': { id },
      'codemode.connectors.setToken': { id, token: 't' },
      'codemode.connectors.signIn.start': { id },
      'codemode.connectors.signIn.status': { id },
      'codemode.connectors.signIn.cancel': { id },
      'codemode.connectors.registry.search': { query: 'crm' },
      'codemode.connectors.session.list': { sessionId: 's1' },
      'codemode.connectors.session.toggle': { sessionId: 's1', id, on: true }
    }
    for (const method of methods) {
      await expect(call(method.name, params[method.name]), method.name).rejects.toThrow(
        'code mode is only available in the desktop app'
      )
    }
  })
})
