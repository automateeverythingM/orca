// What the relay sends a connector's server: its address from the connector list and its secret from
// Orca's credential store, under the same rules as run_js calls (https only, bound to its address).
import { createHash } from 'node:crypto'
import { readBotToolOAuth } from '../../bots/bot-tool-credentials'
import type {
  BotToolCredentialAnswer,
  BotToolCredentialSource
} from '../../bots/tool-oauth/bot-tool-credential-source'
import {
  botToolAccessToken,
  botToolSignInState,
  refreshBotToolAccessToken
} from '../../bots/tool-oauth/bot-tool-oauth-tokens'
import type { CodemodeConnectorAuth } from './codemode-connector-auth'
import { assertTarget, savedHeaders } from './codemode-connector-fetch'
import type { CodemodeConnectorStore } from './codemode-connector-store'

export type OpenedConnectors = { store: CodemodeConnectorStore; auth: CodemodeConnectorAuth }

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function connectorCredentialSource(
  opened: () => OpenedConnectors | null
): BotToolCredentialSource {
  return async (request): Promise<BotToolCredentialAnswer> => {
    const wiring = opened()
    const connector = wiring?.store.get(request.credentialId)
    if (!wiring || !connector?.enabled) {
      return { kind: 'missing' }
    }
    const { url } = connector
    // Throws for an address a secret may not go to; the relay answers that call as unavailable.
    assertTarget(connector, new URL(url))
    const key = wiring.auth.key(connector.id)
    if (connector.auth === 'none') {
      return { kind: 'ready', url, headers: {}, session: digest(['none', url]) }
    }
    if (connector.auth === 'token') {
      const headers = savedHeaders(connector, key)
      return Object.keys(headers).length === 0
        ? { kind: 'sign-in-needed' }
        : { kind: 'ready', url, headers, session: digest([url, Object.entries(headers).sort()]) }
    }
    // The sign-in must have been made for this very address.
    if (readBotToolOAuth(key.folder, key.credentialId)?.url !== url) {
      return { kind: 'sign-in-needed' }
    }
    let grant: Awaited<ReturnType<typeof botToolAccessToken>>
    try {
      grant = request.rejected
        ? await refreshBotToolAccessToken(key, request.rejected, request.signal)
        : await botToolAccessToken(key, request.signal)
    } catch {
      return { kind: 'unavailable' }
    }
    if (!grant) {
      // A token server that didn't answer leaves the sign-in standing.
      return botToolSignInState(key)?.state === 'signed-in'
        ? { kind: 'unavailable' }
        : { kind: 'sign-in-needed' }
    }
    return {
      kind: 'ready',
      url,
      headers: { authorization: `Bearer ${grant.token}` },
      session: digest(['oauth', url, grant.grant]),
      bearer: grant.token
    }
  }
}
