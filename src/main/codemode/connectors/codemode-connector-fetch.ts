import type { CodemodeConnector } from '../../../shared/codemode/codemode-connector-types'
import { readBotToolCredential, readBotToolOAuth } from '../../bots/bot-tool-credentials'
import type { BotToolOAuthKey } from '../../bots/tool-oauth/bot-tool-oauth'
import {
  botToolAccessToken,
  refreshBotToolAccessToken
} from '../../bots/tool-oauth/bot-tool-oauth-tokens'
import type { CodemodeConnectorStore } from './codemode-connector-store'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])

type KeyOf = { key(id: string): BotToolOAuthKey }

const needsSignIn = (connector: CodemodeConnector): Error =>
  new Error(`connector ${connector.name} needs sign-in`)

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) {
    // Its headers and body would bypass the ones set here.
    throw new TypeError('connector fetch takes a URL, not a Request')
  }
  return new URL(input)
}

/** The address a credential may go to: the connector's own https origin, nothing else. */
export function assertTarget(connector: CodemodeConnector, target: URL): void {
  const own = new URL(connector.url)
  const localTest =
    process.env.NODE_ENV === 'test' && own.protocol === 'http:' && LOCAL_HOSTS.has(own.hostname)
  if (own.protocol !== 'https:' && !localTest) {
    throw new Error(`connector ${connector.name} must use https`)
  }
  if (target.origin !== own.origin) {
    throw new Error(`connector ${connector.name} may only call ${own.origin}`)
  }
}

async function bearerFor(
  connector: CodemodeConnector,
  key: BotToolOAuthKey,
  signal: AbortSignal | undefined
): Promise<string> {
  // The sign-in must have been made for this very address.
  if (readBotToolOAuth(key.folder, key.credentialId)?.url !== connector.url) {
    throw needsSignIn(connector)
  }
  const grant = await botToolAccessToken(key, signal)
  if (!grant) {
    throw needsSignIn(connector)
  }
  return grant.token
}

export function savedHeaders(
  connector: CodemodeConnector,
  key: BotToolOAuthKey
): Record<string, string> {
  const credential = readBotToolCredential(key.folder, key.credentialId)
  return credential && credential.url === connector.url ? credential.headers : {}
}

/**
 * `fetch` for one connector's upstream client: attaches its credential, never follows a redirect,
 * and after a 401 refreshes an OAuth sign-in once and retries once.
 */
export function connectorFetch(
  id: string,
  store: CodemodeConnectorStore,
  auth: KeyOf
): typeof fetch {
  return async (input, init) => {
    const connector = store.get(id)
    if (!connector) {
      throw new Error(`unknown connector: ${id}`)
    }
    const target = requestUrl(input)
    assertTarget(connector, target)
    const key = auth.key(id)
    const signal = init?.signal ?? undefined
    const send = async (credential: Record<string, string>): Promise<Response> => {
      const headers = new Headers(init?.headers)
      headers.delete('authorization')
      for (const [name, value] of Object.entries(credential)) {
        headers.set(name, value)
      }
      const response = await fetch(target, { ...init, headers, redirect: 'manual' })
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel()
        throw new Error(`connector ${connector.name} redirected; refusing to follow`)
      }
      return response
    }

    if (connector.auth !== 'oauth') {
      const response = await send(connector.auth === 'token' ? savedHeaders(connector, key) : {})
      if (response.status === 401) {
        await response.body?.cancel()
        throw needsSignIn(connector)
      }
      return response
    }
    const token = await bearerFor(connector, key, signal)
    const first = await send({ authorization: `Bearer ${token}` })
    if (first.status !== 401) {
      return first
    }
    await first.body?.cancel()
    const renewed = await refreshBotToolAccessToken(key, token, signal)
    if (!renewed) {
      throw needsSignIn(connector)
    }
    const second = await send({ authorization: `Bearer ${renewed.token}` })
    if (second.status === 401) {
      await second.body?.cancel()
      throw needsSignIn(connector)
    }
    return second
  }
}
