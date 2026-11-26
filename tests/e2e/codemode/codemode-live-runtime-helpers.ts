// Runtime-call and connector helpers for the live code mode specs; not a spec itself.
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { waitForSessionReady } from '../desktop/renderer-probes/store'
import { FakeOAuthMcpServer } from '../../../src/main/bots/tool-oauth/testing/fake-oauth-mcp-server'

/** Calls this computer's runtime the way the settings page does; a refusal throws its text. */
export async function runtimeCall(page: Page, method: string, params?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ method, params }) => {
      const answer = await window.api.runtime.call({ method, params })
      if (!answer.ok) {
        throw new Error(answer.error.message)
      }
      return answer.result
    },
    { method, params }
  )
}

export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined
}

/**
 * Adds the fake OAuth MCP server as connector `fake` and signs it in the way a user would: the
 * app opens the browser and the user approves. The server stops after the app does.
 */
export async function addSignedInConnector(
  page: Page,
  app: ElectronApplication,
  cleanup: (run: () => Promise<void>) => void
): Promise<void> {
  const server = await FakeOAuthMcpServer.start()
  cleanup(() => server.stop())
  await app.evaluate(({ shell }) => {
    // Why: the fake server is loopback http, which connectors accept only under NODE_ENV=test
    // (read per request); the E2E app launches as development.
    process.env.NODE_ENV = 'test'
    // The user approving in the browser: follow the authorize URL, then hit the app's callback.
    shell.openExternal = async (url) => {
      const authorized = await fetch(url, { redirect: 'manual' })
      const location = authorized.headers.get('location')
      if (location) {
        await fetch(location)
      }
    }
  })
  await waitForSessionReady(page)
  const added = field(
    await runtimeCall(page, 'codemode.connectors.add', { url: server.mcpUrl, name: 'fake' }),
    'connector'
  )
  const id = field(added, 'id')
  expect(field(added, 'auth')).toBe('oauth')
  expect(typeof id).toBe('string')
  await runtimeCall(page, 'codemode.connectors.signIn.start', { id })
  await expect
    .poll(
      async () =>
        field(await runtimeCall(page, 'codemode.connectors.signIn.status', { id }), 'state'),
      { timeout: 30_000 }
    )
    .toBe('done')
  const listed = field(await runtimeCall(page, 'codemode.connectors.list'), 'connectors')
  expect(listed).toEqual([expect.objectContaining({ id, name: 'fake', status: 'connected' })])
}
