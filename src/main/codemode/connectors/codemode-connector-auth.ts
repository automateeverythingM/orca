import { isIP } from 'node:net'
import { hostname } from 'node:os'
import {
  botToolSignInFailureWords,
  type BotToolSignInProgress
} from '../../../shared/bot-tool-sign-in'
import {
  CODEMODE_CONNECTOR_NAME,
  CODEMODE_RESERVED_NAMES,
  type CodemodeConnector
} from '../../../shared/codemode/codemode-connector-types'
import {
  botToolCredentialsTransaction,
  changeBotToolCredentials,
  readBotToolCredential
} from '../../bots/bot-tool-credentials'
import {
  BotToolSignInError,
  discoveryOptions,
  type BotToolOAuthKey
} from '../../bots/tool-oauth/bot-tool-oauth'
import { discoverBotToolAuth } from '../../bots/tool-oauth/bot-tool-oauth-discovery'
import { revokeBotToolSignIns, signOutBotTool } from '../../bots/tool-oauth/bot-tool-oauth-revoke'
import { createBotToolSignIn } from '../../bots/tool-oauth/bot-tool-oauth-sign-in'
import { botToolSignInState } from '../../bots/tool-oauth/bot-tool-oauth-tokens'
import {
  botToolSignInProgress,
  cancelBotToolSignIn,
  connectBotToolSignIn
} from '../../bots/tool-oauth/bot-tool-sign-in-flows'
import {
  assertConnectorUrl,
  CODEMODE_CONNECTOR_CREDENTIAL_FOLDER,
  type CodemodeConnectorStore
} from './codemode-connector-store'

export type ConnectorStatus = 'connected' | 'sign-in-needed' | 'token-needed' | 'error'

const NAME_MAX = 40
const HOST_PREFIXES = new Set(['mcp', 'api', 'www'])
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'])
const TOKEN = /^[\x21-\x7e]+$/

function hostLabel(url: string): string {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(host) !== 0 || host === 'localhost') {
    return 'local'
  }
  const labels = host.split('.').filter(Boolean)
  while (labels.length > 2 && HOST_PREFIXES.has(labels[0]!)) {
    labels.shift()
  }
  const n = labels.length
  if (n >= 3 && SECOND_LEVEL.has(labels[n - 2]!) && labels[n - 1]!.length === 2) {
    return labels[n - 3]!
  }
  return labels[Math.max(0, n - 2)] ?? ''
}

/** The host's label as a connector name, with `-2`, `-3`… when that name is taken or reserved. */
export function defaultConnectorName(url: string, taken: readonly string[]): string {
  let base = hostLabel(url).replace(/[^a-z0-9_-]/g, '-')
  if (!base) {
    base = 'connector'
  } else if (!/^[a-z]/.test(base)) {
    base = `mcp-${base}`
  }
  const unavailable = new Set([...taken, ...CODEMODE_RESERVED_NAMES])
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`
    const name = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`
    if (!unavailable.has(name) && CODEMODE_CONNECTOR_NAME.test(name)) {
      return name
    }
  }
}

const sameUrl = (a: string, b: string): boolean => {
  try {
    return new URL(a).href === new URL(b).href
  } catch {
    return a === b
  }
}

/** Adds, signs in and removes connectors; secrets live in the bot tool credential store. */
export class CodemodeConnectorAuth {
  constructor(private readonly store: CodemodeConnectorStore) {}

  key(id: string): BotToolOAuthKey {
    return { folder: CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, credentialId: id }
  }

  async add(input: { url: string; name?: string }): Promise<CodemodeConnector> {
    // Why: checked before discovery, so a refused url or name never reaches the network.
    assertConnectorUrl(input.url)
    if (input.name !== undefined) {
      this.store.assertNewName(input.name)
    }
    this.assertNotAdded(input.url)
    const need = await discoverBotToolAuth(input.url, discoveryOptions())
    if (need.kind === 'unavailable') {
      throw new Error(`could not reach ${input.url}`)
    }
    this.assertNotAdded(input.url)
    const kind = need.kind === 'unsupported' ? 'token' : need.kind
    const name =
      input.name ??
      defaultConnectorName(
        input.url,
        this.store.list().map((c) => c.name)
      )
    const connector = this.store.add({ name, url: input.url, auth: kind })
    if (kind === 'oauth') {
      try {
        await createBotToolSignIn(this.key(connector.id), connector.url)
      } catch (error) {
        this.store.remove(connector.id)
        throw error
      }
    }
    return connector
  }

  setToken(id: string, token: string): void {
    const connector = this.require(id)
    if (connector.auth !== 'token') {
      throw new Error(`connector ${connector.name} does not use a token`)
    }
    const value = token.trim()
    if (!TOKEN.test(value)) {
      throw new Error('token must be one line of printable characters')
    }
    changeBotToolCredentials(
      CODEMODE_CONNECTOR_CREDENTIAL_FOLDER,
      new Map([[id, { url: connector.url, headers: { authorization: `Bearer ${value}` } }]])
    )
  }

  async startSignIn(id: string): Promise<{ attemptId: string; authorizationOrigin: string }> {
    const connector = this.require(id)
    if (connector.auth !== 'oauth') {
      throw new Error(`connector ${connector.name} does not use sign-in`)
    }
    try {
      return await connectBotToolSignIn(this.key(id))
    } catch (error) {
      throw error instanceof BotToolSignInError
        ? new Error(botToolSignInFailureWords(error.code, hostname()))
        : error
    }
  }

  signInProgress(id: string): BotToolSignInProgress {
    return botToolSignInProgress(this.key(id))
  }

  cancelSignIn(id: string, attemptId?: string): void {
    cancelBotToolSignIn(this.key(id), attemptId)
  }

  status(id: string): ConnectorStatus {
    const connector = this.require(id)
    if (connector.auth === 'none') {
      return 'connected'
    }
    if (connector.auth === 'token') {
      const saved = readBotToolCredential(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, id)
      return saved?.url === connector.url && saved.headers.authorization
        ? 'connected'
        : 'token-needed'
    }
    const state = botToolSignInState(this.key(id))
    if (state?.state === 'signed-in') {
      return 'connected'
    }
    return !state || state.problem ? 'error' : 'sign-in-needed'
  }

  /** Signs out (best effort), forgets the credential, then drops the connector from the list. */
  async remove(id: string): Promise<void> {
    const connector = this.require(id)
    if (connector.auth === 'oauth') {
      this.cancelSignIn(id)
      await signOutBotTool(this.key(id)).catch(() => {})
    }
    const dropped = await botToolCredentialsTransaction(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, () =>
      changeBotToolCredentials(CODEMODE_CONNECTOR_CREDENTIAL_FOLDER, new Map(), new Set([id]))
    )
    revokeBotToolSignIns(dropped)
    this.store.remove(id)
  }

  private assertNotAdded(url: string): void {
    if (this.store.list().some((c) => sameUrl(c.url, url))) {
      throw new Error(`connector already added: ${url}`)
    }
  }

  private require(id: string): CodemodeConnector {
    const connector = this.store.get(id)
    if (!connector) {
      throw new Error(`unknown connector: ${id}`)
    }
    return connector
  }
}
