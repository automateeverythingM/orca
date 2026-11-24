// Live proof for code mode: a real agent in a native chat uses run_js against a stdio MCP server.
// Manual only: it needs the developer's Claude login and spends a little usage.
// Run: ORCA_CODEMODE_LIVE=1 ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm run test:e2e tests/e2e/codemode/codemode-live.spec.ts

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from '../desktop/renderer-probes/store'
import { fakeCrmServerSpec } from '../../../src/main/codemode/mcp-pool/testing/fake-crm-command'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'

const LIVE = process.env.ORCA_CODEMODE_LIVE === '1'
const PROMPT =
  'Using the fake-crm MCP server through code mode: find x@y.com, rename them to Bob, add them to Team A, and add 10 credits. Then tell me their final state.'
const SHOTS =
  process.env.ORCA_CODEMODE_LIVE_SHOTS ?? path.join(os.tmpdir(), 'orca-codemode-live-shots')

type CrmUser = { id: string; email: string; name: string; groups: string[]; credits: number }
type ToolUse = { name: string; input: Record<string, unknown> }
type Transcript = { toolUses: ToolUse[]; toolResults: string[]; finalText: string | null }

test.use({ seedTestRepo: false })

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

/** Claude keeps its macOS login in the login keychain, which `security` finds through HOME. */
async function shareLoginKeychain(app: ElectronApplication): Promise<void> {
  const library = path.join(await appHome(app), 'Library')
  await mkdir(library, { recursive: true })
  await symlink(path.join(os.homedir(), 'Library', 'Keychains'), path.join(library, 'Keychains'))
}

/** Opens a native Claude chat on a fresh folder workspace whose `.orca/mcp.json` runs fake-crm. */
async function startClaudeChat(
  page: Page,
  app: ElectronApplication,
  mode: AgentChatPermissionMode,
  cleanup: (run: () => Promise<void>) => void
): Promise<string> {
  const { folder, stateFile } = await makeWorkspace()
  cleanup(() => rm(folder, { recursive: true, force: true }))
  await shareLoginKeychain(app)
  await configureChat(page, mode)
  await openFolderWorkspace(page, folder)
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const claude = page.getByRole('menuitem', { name: /^Claude(?:\s|$)/i }).first()
  await expect(claude).toBeVisible({ timeout: 15_000 })
  await claude.click({ force: true })
  const field = page.locator('[data-composer-field] [contenteditable="true"]').last()
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.click({ force: true })
  await page.keyboard.insertText(PROMPT)
  await page.keyboard.press('Enter')
  return stateFile
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

function parseTranscript(lines: TranscriptLine[]): Transcript {
  const transcript: Transcript = { toolUses: [], toolResults: [], finalText: null }
  for (const entry of lines) {
    const content = Array.isArray(entry?.message?.content) ? entry.message.content : []
    for (const block of content) {
      if (block?.type === 'tool_use') {
        transcript.toolUses.push({ name: block.name, input: block.input ?? {} })
        transcript.finalText = null
      } else if (block?.type === 'tool_result') {
        transcript.toolResults.push(JSON.stringify(block.content))
        transcript.finalText = null
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        transcript.finalText = entry?.type === 'assistant' ? block.text : null
      }
    }
  }
  return transcript
}

/** The chat's own Claude transcript (not the title helper's): the one with the prompt and the most tool calls. */
async function readClaudeTranscript(home: string): Promise<Transcript> {
  let best: Transcript = { toolUses: [], toolResults: [], finalText: null }
  for (const file of await listJsonl(path.join(home, '.claude', 'projects'))) {
    const text = await readFile(file, 'utf8')
    if (!text.includes('through code mode')) {
      continue
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const transcript = parseTranscript(lines.map((line): TranscriptLine => JSON.parse(line)))
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

/** Opens the turn's tool rows and screenshots the run_js row with the calls it made. */
async function shootRunJsRow(page: Page, name: string): Promise<void> {
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

/** Answers the card on screen, if any: Deny the add_credits call, allow everything else once. */
async function answerShownCard(page: Page, seen: string[]): Promise<boolean> {
  const question = page.locator('[data-native-chat-question-card]').first()
  if (await question.isVisible().catch(() => false)) {
    const text = (await question.innerText()).replace(/\s+/g, ' ')
    const choice = /add_credits/.test(text) ? 'Deny' : 'Allow once'
    if (seen.at(-1) !== text) {
      seen.push(text)
      await page.screenshot({ path: path.join(SHOTS, `claude-ask-card-${seen.length}.png`) })
    }
    await question.getByRole('button', { name: new RegExp(`${choice}$`) }).click({ force: true })
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
async function answerCards(page: Page, home: string): Promise<string[]> {
  const seen: string[] = []
  let quiet = 0
  await expect(async () => {
    const answered = await answerShownCard(page, seen)
    quiet = answered || (await readClaudeTranscript(home)).finalText === null ? 0 : quiet + 1
    expect(quiet, `cards seen: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(3)
  }).toPass({ timeout: 5 * 60_000, intervals: [1_000, 2_000] })
  return seen
}

test.describe('code mode with a real agent', () => {
  test.skip(!LIVE, 'Live agent run: set ORCA_CODEMODE_LIVE=1 (uses your Claude login)')
  test.skip(process.platform !== 'darwin', 'Shares the macOS login keychain with the isolated HOME')
  // A real agent turn, with a person answering its approval cards, can take minutes.
  test.setTimeout(8 * 60_000)

  test('Claude runs the CRM task in run_js in full access', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    const stateFile = await startClaudeChat(
      orcaPage,
      electronApp,
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
    expect(names.filter((name) => name === 'mcp__orca__run_js').length).toBeGreaterThanOrEqual(1)
    expect(names.filter((name) => /fake[-_]crm/.test(name))).toEqual([])
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
    const stateFile = await startClaudeChat(
      orcaPage,
      electronApp,
      'ask',
      registerPostElectronShutdownCleanup
    )
    const home = await appHome(electronApp)
    const cards = await answerCards(orcaPage, home)
    console.log(`[codemode-live:ask] cards: ${JSON.stringify(cards, null, 2)}`)

    const transcript = await readClaudeTranscript(home)
    const crm = await readCrm(stateFile)
    logEvidence('ask', transcript, crm)
    const names = transcript.toolUses.map((use) => use.name)
    expect(names).toContain('mcp__orca__run_js')
    expect(names.filter((name) => /fake[-_]crm/.test(name))).toEqual([])
    expect(cards.some((card) => /add_credits/.test(card))).toBe(true)
    expect(
      transcript.toolResults.some((result) =>
        result.includes('mcp.fake-crm.add_credits: denied by user')
      )
    ).toBe(true)
    expect(crm?.credits).toBe(0)
    await shootRunJsRow(orcaPage, 'claude-ask-deny.png')
  })
})
