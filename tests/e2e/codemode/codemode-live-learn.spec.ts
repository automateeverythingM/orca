// Live proof for code mode Learn: repeated scripts get a nudge, and the real writer proposes a function.
// Manual only: it needs the developer's Claude login and spends a little usage.
// Run: ORCA_CODEMODE_LIVE=1 ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm run test:e2e tests/e2e/codemode/codemode-live-learn.spec.ts

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import {
  CLAUDE_CREDENTIAL_ENV,
  LIVE,
  appHome,
  readClaudeTranscript,
  sendInNewClaudeChat,
  startClaudeChat
} from './codemode-live-helpers'
import { field, runtimeCall } from './codemode-live-runtime-helpers'

// Scenario 7a: Learn on; the same script shape (other literals) in a second chat gets the nudge.
const learnPrompt = (marker: string, amount: number) =>
  `${marker}: call run_js exactly once with this code and nothing else, then reply done.\n` +
  "const user = JSON.parse(await mcp['fake-crm'].find_user({ email: 'x@y.com' }))\n" +
  `return JSON.parse(await mcp['fake-crm'].add_credits({ user_id: user.id, amount: ${amount} })).credits`
const LEARN_ONE = 'Learn check one'
const LEARN_TWO = 'Learn check two'
const LEARN_NUDGE = 'you have run this same script in 1 other chat'

test.use({ seedTestRepo: false, orcaAppExtraEnv: CLAUDE_CREDENTIAL_ENV })

test.describe('code mode with a real agent', () => {
  test.skip(!LIVE, 'Live agent run: set ORCA_CODEMODE_LIVE=1')
  test.skip(
    Object.keys(CLAUDE_CREDENTIAL_ENV).length === 0,
    'Set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY'
  )
  // A real agent turn, with a person answering its approval cards, can take minutes.
  test.setTimeout(8 * 60_000)

  test('Claude: the same task in two chats gets the Learn nudge', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    // Learn is off by default; record this app's runs.
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ codemodeLearnEnabled: true })
    })
    const home = await appHome(electronApp)
    const runJsResult = async (marker: string): Promise<string | null> => {
      const transcript = await readClaudeTranscript(home, marker)
      const use = transcript.toolUses.find((entry) => entry.name === 'mcp__orca__run_js')
      return use ? (transcript.outcomes.get(use.id)?.text ?? null) : null
    }

    await startClaudeChat(
      orcaPage,
      'full-access',
      registerPostElectronShutdownCleanup,
      learnPrompt(LEARN_ONE, 5)
    )
    await expect
      .poll(() => runJsResult(LEARN_ONE), { timeout: 5 * 60_000, intervals: [2_000] })
      .not.toBeNull()
    expect(await runJsResult(LEARN_ONE)).not.toContain('Note: you have run this same script')

    await sendInNewClaudeChat(orcaPage, learnPrompt(LEARN_TWO, 9))
    await expect
      .poll(() => runJsResult(LEARN_TWO), { timeout: 5 * 60_000, intervals: [2_000] })
      .not.toBeNull()
    expect(await runJsResult(LEARN_TWO)).toContain(LEARN_NUDGE)
  })
  test('Claude + real writer: Learn proposes a function from a repeated script', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    // The real writer runs on this machine's Claude login and can take minutes.
    test.setTimeout(15 * 60_000)
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ codemodeLearnEnabled: true })
    })
    const home = await appHome(electronApp)
    const ran = async (marker: string): Promise<boolean> => {
      const transcript = await readClaudeTranscript(home, marker)
      const use = transcript.toolUses.find((entry) => entry.name === 'mcp__orca__run_js')
      return use ? transcript.outcomes.has(use.id) : false
    }
    const stateFile = await startClaudeChat(
      orcaPage,
      'full-access',
      registerPostElectronShutdownCleanup,
      learnPrompt(LEARN_ONE, 5)
    )
    await expect.poll(() => ran(LEARN_ONE), { timeout: 5 * 60_000, intervals: [2_000] }).toBe(true)
    await sendInNewClaudeChat(orcaPage, learnPrompt(LEARN_TWO, 9))
    await expect.poll(() => ran(LEARN_TWO), { timeout: 5 * 60_000, intervals: [2_000] }).toBe(true)

    const started = await runtimeCall(orcaPage, 'codemode.learn.propose', {})
    console.log(`[codemode-live:learn] propose: ${JSON.stringify(started)}`)
    expect(field(started, 'started')).toBe(true)

    const text = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined
    type Proposal = { id: string; state: string; testStatus?: string; reason?: string }
    const finished = async (): Promise<Proposal | null> => {
      const view = await runtimeCall(orcaPage, 'codemode.learn.proposals')
      const list = field(view, 'proposals')
      const done = Array.isArray(list)
        ? list.find((p) => ['ready', 'failed'].includes(String(field(p, 'state'))))
        : null
      return done
        ? {
            id: String(field(done, 'id')),
            state: String(field(done, 'state')),
            testStatus: text(field(done, 'testStatus')),
            reason: text(field(done, 'testReason') ?? field(done, 'reason'))
          }
        : null
    }
    await expect.poll(finished, { timeout: 5 * 60_000, intervals: [5_000] }).not.toBeNull()
    const proposal = (await finished())!
    console.log(`[codemode-live:learn] proposal: ${JSON.stringify(proposal)}`)

    if (proposal.state === 'ready' && proposal.testStatus === 'passed') {
      const saved = await runtimeCall(orcaPage, 'codemode.learn.saveProposal', {
        id: proposal.id,
        scope: 'project'
      })
      const name = String(field(saved, 'name'))
      const lib = await readFile(
        path.join(path.dirname(stateFile), '.orca', 'lib', `${name}.js`),
        'utf8'
      )
      expect(lib).toContain('@saved-by learn')
    }
  })
})
