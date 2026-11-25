import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { CodemodeConnectorView } from '../../../../../shared/codemode/codemode-connector-types'
import type { CodemodeLibEntryView } from '../../../../../shared/codemode/codemode-lib-types'
import { ActiveSettingsSectionProvider } from '../section-layout/SettingsSection'
import { CodemodeSettingsPage } from './CodemodeSettingsPage'
import type { CodemodeRegistryEntry } from './codemode-connectors-client'

const CONNECTORS: CodemodeConnectorView[] = [
  {
    id: 'cn-linear-0001',
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    trusted: true,
    enabled: true,
    status: 'connected'
  },
  {
    id: 'cn-notion-0002',
    name: 'notion',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    trusted: false,
    enabled: true,
    status: 'sign-in-needed'
  },
  {
    id: 'cn-github-0003',
    name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    trusted: false,
    enabled: false,
    status: 'token-needed'
  }
]

const TRUSTED = ['filesystem', 'postgres']

const REGISTRY: CodemodeRegistryEntry[] = [
  {
    name: 'io.github.github/github-mcp-server',
    title: 'GitHub',
    description: 'Read repositories, issues and pull requests, and open new ones.',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token'
  },
  {
    name: 'com.gitlab/mcp',
    title: 'GitLab',
    description:
      'Search projects, merge requests and pipelines across the GitLab instances you can reach, with the permissions of the signed-in account.',
    url: 'https://gitlab.com/api/v4/mcp',
    auth: 'oauth'
  },
  {
    name: 'dev.gitbook/mcp',
    title: 'GitBook',
    description: 'Search and read published GitBook docs.',
    url: 'https://mcp.gitbook.com/mcp',
    auth: 'oauth'
  }
]

const DAY = 86_400_000
const FUNCTIONS: CodemodeLibEntryView[] = [
  {
    name: 'addCreditsByEmail',
    description: 'Find an FC Urban user by email and add credits.',
    params: [{ name: 'email', type: 'string' }],
    savedBy: 'agent',
    scope: 'project',
    uses: 0,
    trusted: false,
    shadowed: false,
    sha256: 'a'.repeat(64)
  },
  {
    name: 'openPullRequests',
    description: 'List open pull requests with their review state.',
    params: [],
    savedBy: 'user',
    scope: 'project',
    uses: 12,
    lastUsedAt: Date.now() - 2 * 3_600_000,
    trusted: true,
    shadowed: false,
    sha256: 'a'.repeat(64)
  },
  {
    name: 'openPullRequests',
    description: 'List open pull requests across every repo.',
    params: [],
    savedBy: 'learn',
    scope: 'global',
    uses: 3,
    lastUsedAt: Date.now() - 9 * DAY,
    trusted: true,
    shadowed: true,
    sha256: 'b'.repeat(64)
  }
]
const SOURCE = `/**
 * @name addCreditsByEmail
 * @description Find an FC Urban user by email and add credits.
 * @param {string} email
 * @saved-by agent
 */
async function addCreditsByEmail({ email, amount }) {
  const user = await tools.fcu.search_contacts({ query: email })
  return tools.fcu.run_action({ action: 'add_credits', id: user.id, amount })
}
`
const HISTORY = [
  { version: '20261120T101500000Z', savedAt: Date.now() - 5 * DAY },
  { version: '20261124T083000000Z', savedAt: Date.now() - DAY }
]
const WORKTREE = makeWorktree({
  id: 'repo-1::/code/platform',
  repoId: 'repo-1',
  path: '/code/platform',
  displayName: 'platform',
  hostId: 'local'
})

function libResult(method: string, functions: CodemodeLibEntryView[]): unknown {
  switch (method) {
    case 'codemode.lib.list':
      return { functions, problems: [] }
    case 'codemode.lib.read':
      return { source: SOURCE, sha256: 'a'.repeat(64) }
    case 'codemode.lib.history':
      return { versions: HISTORY }
    case 'codemode.learn.status':
      return { enabled: false, stats: { runs: 0, calls: 0, bytes: 0, oldest: null } }
    case 'codemode.learn.list':
      return { scripts: [], chains: [], chainsComputedAt: null }
    default:
      return undefined
  }
}

function stubRuntime(
  connectors: CodemodeConnectorView[],
  trusted: string[],
  functions: CodemodeLibEntryView[] = []
): void {
  useAppStore.setState((state) => ({
    worktreesByRepo: { 'repo-1': [WORKTREE] },
    activeWorktreeId: functions.length > 0 ? WORKTREE.id : null,
    activeWorkspaceExecutionHostId: 'local',
    settings: state.settings
      ? {
          ...state.settings,
          codemodeEnabled: true,
          codemodeTrustedServers: trusted
        }
      : state.settings
  }))
  const call = window.api.runtime.call
  Reflect.set(window.api, 'runtime', {
    ...window.api.runtime,
    call: async (args: Parameters<typeof call>[0]) => {
      switch (args.method) {
        case 'codemode.connectors.list':
          return { ok: true, result: { connectors } }
        case 'codemode.connectors.registry.search':
          return { ok: true, result: { entries: REGISTRY } }
        default: {
          const result = libResult(args.method, functions)
          return result === undefined ? call(args) : { ok: true, result }
        }
      }
    }
  })
}

function Preview({ tall = false }: { tall?: boolean }): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return settings ? (
    <div className={tall ? 'min-h-[760px] bg-background p-6' : 'bg-background p-6'}>
      <ActiveSettingsSectionProvider value="code-mode">
        <CodemodeSettingsPage
          settings={settings}
          updateSettings={updateSettings}
          searchEntries={[]}
        />
      </ActiveSettingsSectionProvider>
    </div>
  ) : null
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function clickButton(text: string, nth = 0): void {
  ;[...document.querySelectorAll<HTMLElement>('button')]
    .filter((button) => button.textContent?.trim() === text)
    .at(nth)
    ?.click()
}

async function openAdd(): Promise<void> {
  await settle(100)
  clickButton('Add connector')
  await settle(250)
}

async function openRowPanels(): Promise<void> {
  await settle(100)
  clickButton('Set token')
  clickButton('Remove', 1)
  await settle(150)
}

async function openRegistry(): Promise<void> {
  await openAdd()
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (trigger) => trigger.textContent?.trim() === 'Search registry'
  )
  tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  await settle(150)
  const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')
  if (field) {
    Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'git')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await settle(700)
}

export const empty = defineFixture({
  width: 820,
  setup: () => stubRuntime([], []),
  render: () => <Preview />
})

export const connectors = defineFixture({
  width: 820,
  setup: () => stubRuntime(CONNECTORS, TRUSTED),
  render: () => <Preview />
})

export const addUrl = defineFixture({
  width: 820,
  setup: () => stubRuntime(CONNECTORS, TRUSTED),
  render: () => <Preview tall />,
  interact: openAdd
})

export const addRegistry = defineFixture({
  width: 820,
  setup: () => stubRuntime(CONNECTORS, TRUSTED),
  render: () => <Preview tall />,
  interact: openRegistry
})

export const rowPanels = defineFixture({
  width: 820,
  setup: () => stubRuntime(CONNECTORS, TRUSTED),
  render: () => <Preview />,
  interact: openRowPanels
})

async function openSource(): Promise<void> {
  await settle(100)
  clickButton('View')
  await settle(300)
}

async function openDelete(): Promise<void> {
  await settle(100)
  clickButton('Delete')
  await settle(150)
}

export const functions = defineFixture({
  width: 820,
  setup: () => stubRuntime([], [], FUNCTIONS),
  render: () => <Preview />,
  interact: openDelete
})

export const functionSource = defineFixture({
  width: 820,
  setup: () => stubRuntime([], [], FUNCTIONS),
  render: () => <Preview tall />,
  interact: openSource
})

export const narrow = defineFixture({
  width: 420,
  setup: () => stubRuntime(CONNECTORS, TRUSTED),
  render: () => <Preview />
})
