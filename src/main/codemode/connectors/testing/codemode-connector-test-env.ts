import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../../shared/secure-storage/secret-store'
import { useBotToolCredentialsRoot } from '../../../bots/bot-tool-credentials'
import { settleBotToolRevocations } from '../../../bots/tool-oauth/bot-tool-oauth-revoke'
import { setBotToolSignInBrowser } from '../../../bots/tool-oauth/bot-tool-sign-in-flows'
import type { FakeOAuthMcpServer } from '../../../bots/tool-oauth/testing/fake-oauth-mcp-server'
import { CodemodeConnectorAuth } from '../codemode-connector-auth'
import { CodemodeConnectorStore } from '../codemode-connector-store'

export type ConnectorTestEnv = {
  dir: string
  storePath: string
  store: CodemodeConnectorStore
  auth: CodemodeConnectorAuth
}

/**
 * A temp connector list and credential root with a fake OS secret store, fresh for every test.
 * `cleanup` runs after each test, before the temp folder is deleted.
 */
export function setUpConnectorTestEnv(cleanup: () => Promise<void> = async () => {}): {
  current: () => ConnectorTestEnv
} {
  let env: ConnectorTestEnv | null = null

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemode-connector-'))
    useBotToolCredentialsRoot(join(dir, 'credentials'))
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
      decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/s, '$1'),
      describeProtectionGap: () => null
    })
    const storePath = join(dir, 'codemode-connectors.json')
    const store = await CodemodeConnectorStore.open(storePath)
    env = { dir, storePath, store, auth: new CodemodeConnectorAuth(store) }
  })

  afterEach(async () => {
    await cleanup()
    await settleBotToolRevocations()
    setBotToolSignInBrowser(null)
    useBotToolCredentialsRoot(null)
    _resetSecretStoreForTests()
    if (env) {
      rmSync(env.dir, { recursive: true, force: true })
    }
    env = null
  })

  return {
    current: () => {
      if (!env) {
        throw new Error('connector test env is only available inside a test')
      }
      return env
    }
  }
}

/** Signs a connector in the way a user would: Orca opens the browser and the user approves. */
export async function signInConnector(
  auth: CodemodeConnectorAuth,
  id: string,
  server: FakeOAuthMcpServer
): Promise<void> {
  setBotToolSignInBrowser((url) => server.approve(url))
  await auth.startSignIn(id)
  await expect.poll(() => auth.signInProgress(id).state).toBe('done')
}
