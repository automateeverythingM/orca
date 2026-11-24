import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import type { CodemodeConnectorView } from '../../../../../shared/codemode/codemode-connector-types'
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

function stubRuntime(connectors: CodemodeConnectorView[], trusted: string[]): void {
  useAppStore.setState((state) => ({
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
        default:
          return call(args)
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

export const narrow = defineFixture({
  width: 420,
  setup: () => stubRuntime(CONNECTORS, TRUSTED),
  render: () => <Preview />
})
