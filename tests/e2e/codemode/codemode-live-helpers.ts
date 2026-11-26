// Shared helpers for the live code mode specs (codemode-live*.spec.ts); not a spec itself.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { waitForSessionReady, ensureTerminalVisible } from '../desktop/renderer-probes/store'
import { fakeCrmServerSpec } from '../../../src/main/codemode/mcp-pool/testing/fake-crm-command'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'

export const LIVE = process.env.ORCA_CODEMODE_LIVE === '1'
export const PROMPT =
  'Using the fake-crm MCP server through code mode: find x@y.com, rename them to Bob, add them to Team A, and add 10 credits. Then tell me their final state.'
export const PROMPT_MARKER = 'through code mode'

export const SHOTS =
  process.env.ORCA_CODEMODE_LIVE_SHOTS ?? path.join(os.tmpdir(), 'orca-codemode-live-shots')

// Every tool Claude used across the live runs; anything else (a direct fake-crm call above all) fails.
export const ALLOWED_TOOLS = new Set(['mcp__orca__run_js'])

export type CrmUser = { id: string; email: string; name: string; groups: string[]; credits: number }
export type ToolUse = { id: string; name: string; input: Record<string, unknown> }
export type ToolOutcome = { text: string; isError: boolean }
export type Transcript = {
  toolUses: ToolUse[]
  toolResults: string[]
  /** Each tool call's result by its tool_use id. */
  outcomes: Map<string, ToolOutcome>
  finalText: string | null
}

export const emptyTranscript = (): Transcript => ({
  toolUses: [],
  toolResults: [],
  outcomes: new Map(),
  finalText: null
})

// Why: the app runs under an isolated HOME, so Claude's login reaches it only through these variables.
export const CLAUDE_CREDENTIAL_ENV = Object.fromEntries(
  ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].flatMap((key) => {
    const value = process.env[key]
    return value ? [[key, value]] : []
  })
)

export async function makeWorkspace(): Promise<{ folder: string; stateFile: string }> {
  const folder = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-codemode-live-')))
  const stateFile = path.join(folder, 'fake-crm-state.json')
  const crm = await fakeCrmServerSpec()
  await mkdir(path.join(folder, '.orca'), { recursive: true })
  const config = { mcpServers: { 'fake-crm': { ...crm, env: { FAKE_CRM_STATE_FILE: stateFile } } } }
  await writeFile(path.join(folder, '.orca', 'mcp.json'), `${JSON.stringify(config, null, 2)}\n`)
  return { folder, stateFile }
}

export async function readCrm(stateFile: string): Promise<CrmUser | null> {
  try {
    const users: CrmUser[] = JSON.parse(await readFile(stateFile, 'utf8'))
    return users.find((user) => user.email === 'x@y.com') ?? null
  } catch {
    return null
  }
}

export async function openFolderWorkspace(page: Page, folder: string): Promise<void> {
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

export async function configureChat(page: Page, mode: AgentChatPermissionMode): Promise<void> {
  await page.evaluate(async (mode) => {
    await window.__store!.getState().updateSettings({
      codemodeEnabled: true,
      nativeChatProviders: { claude: true, codex: true },
      nativeChatPermissionMode: mode
    })
  }, mode)
}

export async function appHome(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app }) => app.getPath('home'))
}

/** Opens a native Claude chat on a fresh folder workspace whose `.orca/mcp.json` runs fake-crm. */
export async function startClaudeChat(
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
export async function sendInNewClaudeChat(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const claude = page.getByRole('menuitem', { name: /^Claude(?:\s|$)/i }).first()
  await expect(claude).toBeVisible({ timeout: 15_000 })
  await claude.click({ force: true })
  const field = page.locator('[data-composer-field] [contenteditable="true"]').last()
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.click({ force: true })
  await page.keyboard.insertText(prompt)
  // Enter can land before the new session accepts input and is then dropped; wait for Send instead.
  const send = page.getByRole('button', { name: 'Send', exact: true }).last()
  await expect(send).toBeEnabled({ timeout: 60_000 })
  await send.click()
  await expect(field).toHaveText('', { timeout: 30_000 })
}

export async function listJsonl(dir: string): Promise<string[]> {
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

export type TranscriptLine = { type?: string; message?: { content?: unknown } } | null

/** Claude may be mid-write on the last line; a line that does not parse yet is skipped. */
export function parseLine(line: string): TranscriptLine[] {
  try {
    return line.trim() ? [JSON.parse(line)] : []
  } catch {
    return []
  }
}

export function parseTranscript(lines: TranscriptLine[]): Transcript {
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
export async function readClaudeTranscript(
  home: string,
  marker = PROMPT_MARKER
): Promise<Transcript> {
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

export function logEvidence(label: string, transcript: Transcript, crm: CrmUser | null): void {
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
export async function openRunJsRows(page: Page): Promise<void> {
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
export async function shootRunJsRow(page: Page, name: string): Promise<void> {
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
export async function answerShownCard(
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
export async function answerCards(
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
