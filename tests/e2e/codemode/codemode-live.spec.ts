// Live proof for code mode: a real agent in a native chat uses run_js against a stdio MCP server.
// Manual only: it needs the developer's Claude login and spends a little usage.
// Run: ORCA_CODEMODE_LIVE=1 ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm run test:e2e tests/e2e/codemode/codemode-live.spec.ts

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from '../desktop/renderer-probes/store'
import { fakeCrmServerSpec } from '../../../src/main/codemode/mcp-pool/testing/fake-crm-command'
import { FakeOAuthMcpServer } from '../../../src/main/bots/tool-oauth/testing/fake-oauth-mcp-server'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'

const LIVE = process.env.ORCA_CODEMODE_LIVE === '1'
const PROMPT =
  'Using the fake-crm MCP server through code mode: find x@y.com, rename them to Bob, add them to Team A, and add 10 credits. Then tell me their final state.'
const PROMPT_MARKER = 'through code mode'
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
const SHOTS =
  process.env.ORCA_CODEMODE_LIVE_SHOTS ?? path.join(os.tmpdir(), 'orca-codemode-live-shots')

// Every tool Claude used across the live runs; anything else (a direct fake-crm call above all) fails.
const ALLOWED_TOOLS = new Set(['mcp__orca__run_js'])

type CrmUser = { id: string; email: string; name: string; groups: string[]; credits: number }
type ToolUse = { id: string; name: string; input: Record<string, unknown> }
type ToolOutcome = { text: string; isError: boolean }
type Transcript = {
  toolUses: ToolUse[]
  toolResults: string[]
  /** Each tool call's result by its tool_use id. */
  outcomes: Map<string, ToolOutcome>
  finalText: string | null
}

const emptyTranscript = (): Transcript => ({
  toolUses: [],
  toolResults: [],
  outcomes: new Map(),
  finalText: null
})

// Why: the app runs under an isolated HOME, so Claude's login reaches it only through these variables.
const CLAUDE_CREDENTIAL_ENV = Object.fromEntries(
  ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].flatMap((key) => {
    const value = process.env[key]
    return value ? [[key, value]] : []
  })
)

test.use({ seedTestRepo: false, orcaAppExtraEnv: CLAUDE_CREDENTIAL_ENV })

async function makeWorkspace(): Promise<{ folder: string; stateFile: string }> {
  const folder = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-codemode-live-')))
  const stateFile = path.join(folder, 'fake-crm-state.json')
  const crm = await fakeCrmServerSpec()
  await mkdir(path.join(folder, '.orca'), { recursive: true })
  const config = { mcpServers: { 'fake-crm': { ...crm, env: { FAKE_CRM_STATE_FILE: stateFile } } } }
  await writeFile(path.join(folder, '.orca', 'mcp.json'), `${JSON.stringify(config, null, 2)}\n`)
  return { folder, stateFile }
}

async function readCrm(stateFile: string): Promise<CrmUser | null> {
  try {
    const users: CrmUser[] = JSON.parse(await readFile(stateFile, 'utf8'))
    return users.find((user) => user.email === 'x@y.com') ?? null
  } catch {
    return null
  }
}

async function openFolderWorkspace(page: Page, folder: string): Promise<void> {
  await waitForSessionReady(page)
  const repoId = await page.evaluate(async (folder) => {
    const result = await window.api.repos.add({ path: folder, kind: 'folder' })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, folder)
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const store = window.__store!
        await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
        await store.getState().fetchWorktrees(id)
        const worktree = store.getState().worktreesByRepo[id]?.[0]
        if (worktree) {
          store.getState().setActiveWorktree(worktree.id)
        }
        return worktree?.id ?? null
      }, repoId)
    )
    .not.toBeNull()
  await ensureTerminalVisible(page)
}

async function configureChat(page: Page, mode: AgentChatPermissionMode): Promise<void> {
  await page.evaluate(async (mode) => {
    await window.__store!.getState().updateSettings({
      codemodeEnabled: true,
      nativeChatProviders: { claude: true, codex: true },
      nativeChatPermissionMode: mode
    })
  }, mode)
}

async function appHome(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app }) => app.getPath('home'))
}

/** Opens a native Claude chat on a fresh folder workspace whose `.orca/mcp.json` runs fake-crm. */
async function startClaudeChat(
  page: Page,
  mode: AgentChatPermissionMode,
  cleanup: (run: () => Promise<void>) => void,
  prompt = PROMPT
): Promise<string> {
  const { folder, stateFile } = await makeWorkspace()
  cleanup(() => rm(folder, { recursive: true, force: true }))
  await configureChat(page, mode)
  await openFolderWorkspace(page, folder)
  await sendInNewClaudeChat(page, prompt)
  return stateFile
}

/** Opens another native Claude chat tab in the active workspace and sends the prompt. */
async function sendInNewClaudeChat(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const claude = page.getByRole('menuitem', { name: /^Claude(?:\s|$)/i }).first()
  await expect(claude).toBeVisible({ timeout: 15_000 })
  await claude.click({ force: true })
  const field = page.locator('[data-composer-field] [contenteditable="true"]').last()
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.click({ force: true })
  await page.keyboard.insertText(prompt)
  await page.keyboard.press('Enter')
}

async function listJsonl(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return listJsonl(full)
      }
      return Promise.resolve(entry.name.endsWith('.jsonl') ? [full] : [])
    })
  )
  return nested.flat()
}

type TranscriptLine = { type?: string; message?: { content?: unknown } } | null

/** Claude may be mid-write on the last line; a line that does not parse yet is skipped. */
function parseLine(line: string): TranscriptLine[] {
  try {
    return line.trim() ? [JSON.parse(line)] : []
  } catch {
    return []
  }
}

function parseTranscript(lines: TranscriptLine[]): Transcript {
  const transcript = emptyTranscript()
  for (const entry of lines) {
    const content = Array.isArray(entry?.message?.content) ? entry.message.content : []
    for (const block of content) {
      if (block?.type === 'tool_use') {
        transcript.toolUses.push({
          id: String(block.id),
          name: block.name,
          input: block.input ?? {}
        })
        transcript.finalText = null
      } else if (block?.type === 'tool_result') {
        const text = JSON.stringify(block.content)
        transcript.toolResults.push(text)
        transcript.outcomes.set(String(block.tool_use_id), {
          text,
          isError: block.is_error === true
        })
        transcript.finalText = null
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        transcript.finalText = entry?.type === 'assistant' ? block.text : null
      }
    }
  }
  return transcript
}

/** The chat's own Claude transcript (not the title helper's): the one with the prompt and the most tool calls. */
async function readClaudeTranscript(home: string, marker = PROMPT_MARKER): Promise<Transcript> {
  let best = emptyTranscript()
  for (const file of await listJsonl(path.join(home, '.claude', 'projects'))) {
    const text = await readFile(file, 'utf8')
    if (!text.includes(marker)) {
      continue
    }
    const transcript = parseTranscript(text.split('\n').flatMap(parseLine))
    if (transcript.toolUses.length >= best.toolUses.length) {
      best = transcript
    }
  }
  return best
}

function logEvidence(label: string, transcript: Transcript, crm: CrmUser | null): void {
  const scripts = transcript.toolUses
    .filter((use) => use.name === 'mcp__orca__run_js')
    .map((use) => String(use.input.code))
  console.log(
    `[codemode-live:${label}] tool calls: ${JSON.stringify(transcript.toolUses.map((use) => use.name))}\n` +
      `[codemode-live:${label}] scripts:\n${scripts.join('\n---\n')}\n` +
      `[codemode-live:${label}] tool results: ${JSON.stringify(transcript.toolResults)}\n` +
      `[codemode-live:${label}] final text: ${transcript.finalText}\n` +
      `[codemode-live:${label}] fake-crm: ${JSON.stringify(crm)}`
  )
}

/** Opens the turn's details and its tool run so the run_js row and its inner calls are mounted. */
async function openRunJsRows(page: Page): Promise<void> {
  const later = page.getByRole('button', { name: 'Later' })
  if (await later.isVisible().catch(() => false)) {
    await later.click({ force: true })
  }
  const conversation = page.getByRole('region', { name: 'Conversation' })
  // The turn's details and its tool run both start collapsed; the run mounts its rows only when open.
  for (const toggle of [/^Toggle turn details$/, /^Used \d+ integrations?/]) {
    const closed = conversation.getByRole('button', { name: toggle, expanded: false })
    for (let i = await closed.count(); i > 0; i -= 1) {
      await closed.first().click({ force: true })
    }
  }
}

/** Opens the turn's tool rows and screenshots the run_js row with the calls it made. */
async function shootRunJsRow(page: Page, name: string): Promise<void> {
  await openRunJsRows(page)
  const row = page.getByRole('button', { name: /^Script/ }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  // The inner-call rows sit under the run_js row (not the approval cards' text).
  const innerCall = page.locator('li').filter({ hasText: /^mcp\.fake-crm\.add_credits/ })
  await expect(innerCall.first()).toBeVisible()
  await innerCall.first().scrollIntoViewIfNeeded()
  await mkdir(SHOTS, { recursive: true })
  const file = path.join(SHOTS, name)
  await page.screenshot({ path: file })
  console.log(`[codemode-live] screenshot: ${file}`)
}

/** Answers the card on screen, if any: Deny what `deny` matches (default add_credits), allow the rest. */
async function answerShownCard(
  page: Page,
  seen: string[],
  deny: RegExp | null = /add_credits/
): Promise<boolean> {
  const question = page.locator('[data-native-chat-question-card]').first()
  if (await question.isVisible().catch(() => false)) {
    const text = (await question.innerText()).replace(/\s+/g, ' ')
    const choice = deny?.test(text) ? 'Deny' : 'Allow once'
    if (seen.at(-1) !== text) {
      seen.push(text)
      await page.screenshot({ path: path.join(SHOTS, `claude-ask-card-${seen.length}.png`) })
    }
    const choose = question.getByRole('button', { name: new RegExp(`${choice}$`) })
    // Fixed-option cards (lib.save, lib.trust) offer a plain Allow instead of Allow once.
    const button =
      choice === 'Allow once' && (await choose.count()) === 0
        ? question.getByRole('button', { name: /^Allow$/ })
        : choose
    await button.click({ force: true })
    const submit = question.getByRole('button', { name: /^Submit/ })
    if (await submit.isEnabled().catch(() => false)) {
      await submit.click({ force: true })
    }
    return true
  }
  // The agent's own approval for run_js itself.
  const allow = page.getByRole('button', { name: /^(Allow|Allow once|Yes)$/ }).first()
  if (await allow.isVisible().catch(() => false)) {
    seen.push('agent approval')
    await allow.click({ force: true })
    return true
  }
  return false
}

/** Answers every card the turn shows until it ends in text with no card for three checks. */
async function answerCards(
  page: Page,
  home: string,
  { deny = /add_credits/, marker = PROMPT_MARKER }: { deny?: RegExp | null; marker?: string } = {}
): Promise<string[]> {
  const seen: string[] = []
  let quiet = 0
  await expect(async () => {
    const answered = await answerShownCard(page, seen, deny)
    quiet =
      answered || (await readClaudeTranscript(home, marker)).finalText === null ? 0 : quiet + 1
    expect(quiet, `cards seen: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(3)
  }).toPass({ timeout: 5 * 60_000, intervals: [1_000, 2_000] })
  return seen
}

/** Calls this computer's runtime the way the settings page does; a refusal throws its text. */
async function runtimeCall(page: Page, method: string, params?: unknown): Promise<unknown> {
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

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined
}

/**
 * Adds the fake OAuth MCP server as connector `fake` and signs it in the way a user would: the
 * app opens the browser and the user approves. The server stops after the app does.
 */
async function addSignedInConnector(
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
