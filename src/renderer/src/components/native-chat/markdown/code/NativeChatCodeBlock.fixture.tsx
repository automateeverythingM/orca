import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatRunCommandContext } from './native-chat-run-command-context'
import {
  createNativeChatCodeBlockRunStore,
  type NativeChatCodeBlockRunRecord
} from './native-chat-code-run-store'
import { NativeChatMarkdownCodeBlockContext } from '../native-chat-markdown-code-block-context'

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo</title>
<style>body{font:14px system-ui;padding:16px}.b{background:#2563eb;color:#fff;border:0;padding:6px 12px;border-radius:6px}</style></head>
<body><h3>Mockup</h3><p>Rendered in a sandbox.</p><button class="b">Click</button></body></html>`

const block = (code: string) => (
  <div className="native-chat-appearance bg-background p-4">
    <NativeChatCodeBlock language="html">{code}</NativeChatCodeBlock>
  </div>
)
const showPreview = (frame: HTMLElement) =>
  [...frame.querySelectorAll<HTMLButtonElement>('[role="radio"]')].at(-1)?.click()

export const code = defineFixture({ width: 560, render: () => block(page) })
export const preview = defineFixture({
  width: 560,
  render: () => block(page),
  interact: showPreview
})
export const narrow = defineFixture({ width: 320, render: () => block(page) })
export const narrowPreview = defineFixture({
  width: 320,
  render: () => block(page),
  interact: showPreview
})
export const snippet = defineFixture({
  width: 560,
  render: () => block('<div class="card">hi</div>')
})

const longPath =
  "Error: Cannot find module '/Users/someone/Documents/projects/orca/centralized-notification/out/cli/index.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)"
const unlabeled = (code: string) => (
  <div className="native-chat-appearance bg-background p-4">
    <NativeChatCodeBlock>{code}</NativeChatCodeBlock>
  </div>
)
// Focus reveals the hover-only actions, so the shot shows them over the code.
const revealActions = (frame: HTMLElement) =>
  frame.querySelector<HTMLButtonElement>('[data-native-chat-code-block] button')?.focus()

export const unlabeledLongPath = defineFixture({
  width: 560,
  render: () => unlabeled(longPath),
  interact: revealActions
})
export const unlabeledNarrow = defineFixture({
  width: 320,
  render: () => unlabeled(longPath),
  interact: revealActions
})
export const unlabeledWrapped = defineFixture({
  width: 320,
  render: () => unlabeled(longPath),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-native-chat-code-block] button')?.click()
    revealActions(frame)
  }
})

const bashScript = [
  'cd /Users/markopavic/orca/workspaces/orca/pteropod',
  'pnpm run build:desktop:assets || true   # keep going on fence',
  'pnpm run build:native && pnpm run ensure:electron-runtime',
  'open dist/mac-arm64/Orca.app'
].join('\n')

function makeFixtureRunner(initial?: NativeChatCodeBlockRunRecord) {
  const records = initial ? new Map([['row-1:1', initial]]) : undefined
  return {
    store: createNativeChatCodeBlockRunStore(async () => ({ unsubscribe: () => {} }), records),
    openInTerminal: async () => true,
    sendToChat: () => true
  }
}

function renderShellBlock(initial?: NativeChatCodeBlockRunRecord, growing = false) {
  return (
    <NativeChatRunCommandContext value={makeFixtureRunner(initial)}>
      <NativeChatMarkdownCodeBlockContext value={{ rowKey: 'row-1', growing }}>
        <div className="native-chat-appearance bg-background p-4">
          <NativeChatCodeBlock language="bash" sourceLine={1} fenceClosed={!growing}>
            {bashScript}
          </NativeChatCodeBlock>
        </div>
      </NativeChatMarkdownCodeBlockContext>
    </NativeChatRunCommandContext>
  )
}

export const bashRunnable = defineFixture({
  width: 640,
  render: () => renderShellBlock(),
  interact: (frame) => {
    const run = frame.querySelector<HTMLButtonElement>('button[aria-label="Run command"]')
    const terminal = frame.querySelector<HTMLButtonElement>('button[aria-label="Open in terminal"]')
    if (!run || !terminal) {
      throw new Error('Bash code block must show Run command and Open in terminal buttons')
    }
  }
})

export const bashRunRunning = defineFixture({
  width: 640,
  render: () =>
    renderShellBlock({
      runId: 1,
      status: 'running',
      output:
        '> orca@2.0.0 build:native\n> node config/scripts/build/build-native.mjs\nCompiling native helpers…',
      truncated: false,
      exitCode: null,
      signal: null,
      startedAt: 0,
      durationMs: null
    })
})

export const bashRunSucceeded = defineFixture({
  width: 640,
  render: () =>
    renderShellBlock({
      runId: 1,
      status: 'succeeded',
      output:
        '> orca@2.0.0 build:native\nBuilt native helpers in 3.4s\nElectron runtime verified: dist/mac-arm64/Orca.app',
      truncated: false,
      exitCode: 0,
      signal: null,
      startedAt: 0,
      durationMs: 3_420
    })
})

export const bashRunFailed = defineFixture({
  width: 640,
  render: () =>
    renderShellBlock({
      runId: 1,
      status: 'failed',
      output:
        "> orca@2.0.0 build:native\nerror: ENOENT: no such file or directory, open 'dist/mac-arm64/Orca.app'\nELIFECYCLE Command failed with exit code 1.",
      truncated: false,
      exitCode: 1,
      signal: null,
      startedAt: 0,
      durationMs: 840
    })
})

export const bashStreaming = defineFixture({
  width: 640,
  render: () => renderShellBlock(undefined, true),
  interact: (frame) => {
    const run = frame.querySelector<HTMLButtonElement>('button[aria-label="Run command"]')
    if (run) {
      throw new Error('Streaming bash fence must hide Run command until closed')
    }
  }
})
