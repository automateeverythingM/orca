// Live proof for code mode: a real agent in a native chat uses run_js against a stdio MCP server.
// Manual only: it needs the developer's Claude login and spends a little usage.
// Run: ORCA_CODEMODE_LIVE=1 ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm run test:e2e tests/e2e/codemode/codemode-live.spec.ts

import { mkdir } from 'node:fs/promises'
import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import {
  ALLOWED_TOOLS,
  CLAUDE_CREDENTIAL_ENV,
  LIVE,
  SHOTS,
  answerCards,
  appHome,
  logEvidence,
  openRunJsRows,
  readClaudeTranscript,
  readCrm,
  sendInNewClaudeChat,
  shootRunJsRow,
  startClaudeChat,
  type ToolOutcome,
  type ToolUse
} from './codemode-live-helpers'
import { addSignedInConnector } from './codemode-live-runtime-helpers'

// Scenario 6: the connector is named `fake`, so Claude sees its tools as mcp__fake__*.
const CONNECTOR_PROMPT =
  'Connector check: first call the fake MCP server\'s echo tool directly with text "direct-ok". Then run one run_js script that returns await mcp.fake.echo({ text: "script-ok" }). Reply with both results.'
const CONNECTOR_MARKER = 'Connector check'
// Scenario 5: two chats in one workspace; the first saves a function, the second calls it.
const SAVE_PROMPT =
  'Save-function check: using the fake-crm MCP server through code mode, save a saved function with lib.save named addCreditsByEmail(email, amount) that finds the user by email and adds that many credits. Do not call it yet. Then say saved.'
const SAVE_MARKER = 'Save-function check'
const USE_PROMPT =
  'Saved-function check: using the saved functions in code mode (lib.*), add 10 credits to x@y.com. Then tell me their final credits.'
const USE_MARKER = 'Saved-function check'

test.use({ seedTestRepo: false, orcaAppExtraEnv: CLAUDE_CREDENTIAL_ENV })

test.describe('code mode with a real agent', () => {
  test.skip(!LIVE, 'Live agent run: set ORCA_CODEMODE_LIVE=1')
  test.skip(
    Object.keys(CLAUDE_CREDENTIAL_ENV).length === 0,
    'Set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY'
  )
  // A real agent turn, with a person answering its approval cards, can take minutes.
  test.setTimeout(8 * 60_000)

  test('Claude runs the CRM task in run_js in full access', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    const stateFile = await startClaudeChat(
      orcaPage,
      'full-access',
      registerPostElectronShutdownCleanup
    )
    await expect
      .poll(() => readCrm(stateFile), { timeout: 5 * 60_000, intervals: [2_000] })
      .toMatchObject({ name: 'Bob', groups: ['Team A'], credits: 10 })
    const home = await appHome(electronApp)
    await expect
      .poll(async () => (await readClaudeTranscript(home)).finalText, {
        timeout: 3 * 60_000,
        intervals: [2_000]
      })
      .toMatch(/Bob/)

    const transcript = await readClaudeTranscript(home)
    const crm = await readCrm(stateFile)
    logEvidence('full-access', transcript, crm)
    const names = transcript.toolUses.map((use) => use.name)
    expect(names).toContain('mcp__orca__run_js')
    expect(names.filter((name) => !ALLOWED_TOOLS.has(name))).toEqual([])
    expect(crm).toEqual({
      id: 'u1',
      email: 'x@y.com',
      name: 'Bob',
      groups: ['Team A'],
      credits: 10
    })
    await shootRunJsRow(orcaPage, 'claude-full-access.png')
  })

  test('Claude in ask mode: denying add_credits on its card leaves credits at 0', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    await mkdir(SHOTS, { recursive: true })
    const stateFile = await startClaudeChat(orcaPage, 'ask', registerPostElectronShutdownCleanup)
    const home = await appHome(electronApp)
    const cards = await answerCards(orcaPage, home)
    console.log(`[codemode-live:ask] cards: ${JSON.stringify(cards, null, 2)}`)

    const transcript = await readClaudeTranscript(home)
    const crm = await readCrm(stateFile)
    logEvidence('ask', transcript, crm)
    const names = transcript.toolUses.map((use) => use.name)
    expect(names).toContain('mcp__orca__run_js')
    expect(names.filter((name) => !ALLOWED_TOOLS.has(name))).toEqual([])
    expect(cards.some((card) => /add_credits/.test(card))).toBe(true)
    expect(
      transcript.toolResults.some((result) =>
        result.includes('mcp.fake-crm.add_credits: denied by user')
      )
    ).toBe(true)
    // The calls the person allowed ran; only the denied one did not.
    expect(crm).toMatchObject({ name: 'Bob', groups: ['Team A'], credits: 0 })
    await shootRunJsRow(orcaPage, 'claude-ask-deny.png')
  })

  test('Claude calls a signed-in connector directly and inside run_js', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    await addSignedInConnector(orcaPage, electronApp, registerPostElectronShutdownCleanup)
    await startClaudeChat(
      orcaPage,
      'full-access',
      registerPostElectronShutdownCleanup,
      CONNECTOR_PROMPT
    )
    const home = await appHome(electronApp)
    await expect
      .poll(async () => (await readClaudeTranscript(home, CONNECTOR_MARKER)).finalText, {
        timeout: 5 * 60_000,
        intervals: [2_000]
      })
      .toMatch(/script-ok/)

    const transcript = await readClaudeTranscript(home, CONNECTOR_MARKER)
    logEvidence('connector', transcript, null)
    const outcome = (use: ToolUse | undefined): ToolOutcome | undefined =>
      use && transcript.outcomes.get(use.id)
    const direct = transcript.toolUses.find((use) => use.name.startsWith('mcp__fake__'))
    const script = transcript.toolUses.find(
      (use) => use.name === 'mcp__orca__run_js' && String(use.input.code).includes('mcp.fake')
    )
    expect(direct, 'a direct mcp__fake__* call').toBeDefined()
    expect(script, 'a run_js call that uses mcp.fake').toBeDefined()
    expect(outcome(direct)).toMatchObject({
      isError: false,
      text: expect.stringContaining('direct-ok')
    })
    expect(outcome(script)).toMatchObject({
      isError: false,
      text: expect.stringContaining('script-ok')
    })
  })

  test('Claude saves a function in one chat and calls it from another', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    await mkdir(SHOTS, { recursive: true })
    // Full access still asks the person for lib.save, so the card is the one being answered.
    const stateFile = await startClaudeChat(
      orcaPage,
      'full-access',
      registerPostElectronShutdownCleanup,
      SAVE_PROMPT
    )
    const home = await appHome(electronApp)
    const saveCards = await answerCards(orcaPage, home, { deny: null, marker: SAVE_MARKER })
    expect(saveCards.some((card) => /addCreditsByEmail/.test(card))).toBe(true)

    await sendInNewClaudeChat(orcaPage, USE_PROMPT)
    // The first call of a saved function may also ask the person to trust it; allow that card.
    const useCards = await answerCards(orcaPage, home, { deny: null, marker: USE_MARKER })
    console.log(
      `[codemode-live:lib] cards: ${JSON.stringify([...saveCards, ...useCards], null, 2)}`
    )

    const transcript = await readClaudeTranscript(home, USE_MARKER)
    const crm = await readCrm(stateFile)
    logEvidence('lib', transcript, crm)
    const scripts = transcript.toolUses
      .filter((use) => use.name === 'mcp__orca__run_js')
      .map((use) => String(use.input.code))
    expect(scripts.some((code) => code.includes('lib.addCreditsByEmail'))).toBe(true)
    // The run view's inner-call rows: the host labels a saved function's load `lib.<name>`.
    await openRunJsRows(orcaPage)
    await expect(
      orcaPage
        .locator('li')
        .filter({ hasText: /^lib\.addCreditsByEmail/ })
        .first()
    ).toBeVisible({ timeout: 30_000 })
    expect(crm).toMatchObject({ email: 'x@y.com', credits: 10 })
  })
})
