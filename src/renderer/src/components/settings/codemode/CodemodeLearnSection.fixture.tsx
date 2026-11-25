import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import type {
  CodemodeLearnListView,
  CodemodeLearnStatusView
} from '../../../../../shared/codemode/codemode-learn-types'
import { CodemodeLearnSection } from './CodemodeLearnSection'

const HOUR = 3_600_000
const SAMPLE = `const user = JSON.parse(await mcp['fake-crm'].find_user({ email: 'dana@example.com' }))
await mcp['fake-crm'].add_to_group({ user_id: user.id, group: 'beta' })
return JSON.parse(await mcp['fake-crm'].add_credits({ user_id: user.id, amount: 120 }))`

const LIST: CodemodeLearnListView = {
  scripts: [
    {
      kind: 'script',
      shape: 'a'.repeat(64),
      sessions: 4,
      runs: 9,
      lastSeen: Date.now() - 3 * HOUR,
      sampleCode: SAMPLE,
      tools: ['mcp.fake-crm.add_credits', 'mcp.fake-crm.add_to_group', 'mcp.fake-crm.find_user'],
      projectRoots: ['/code/platform']
    }
  ],
  chains: [
    {
      kind: 'chain',
      signature: 'linear-chain',
      tools: ['linear.list_issues', 'linear.get_issue', 'github.create_pull_request'],
      sessions: 3,
      occurrences: 5,
      lastSeen: Date.now() - 26 * HOUR
    },
    {
      kind: 'chain',
      signature: 'notion-chain',
      tools: ['notion.search', 'notion.fetch', 'slack.send_message'],
      sessions: 2,
      occurrences: 2,
      lastSeen: Date.now() - 5 * 24 * HOUR
    }
  ],
  chainsComputedAt: Date.now()
}
const NONE: CodemodeLearnListView = { scripts: [], chains: [], chainsComputedAt: null }
const stats = (runs: number, bytes: number): CodemodeLearnStatusView['stats'] => ({
  runs,
  calls: runs * 3,
  bytes,
  oldest: runs > 0 ? Date.now() - 9 * 24 * HOUR : null
})

function stubLearn(enabled: boolean, runs: number, bytes: number, list: CodemodeLearnListView) {
  useAppStore.setState((state) => ({
    settings: state.settings
      ? { ...state.settings, codemodeEnabled: true, codemodeLearnEnabled: enabled }
      : state.settings
  }))
  const call = window.api.runtime.call
  const status: CodemodeLearnStatusView = { enabled, stats: stats(runs, bytes) }
  Reflect.set(window.api, 'runtime', {
    ...window.api.runtime,
    call: async (args: Parameters<typeof call>[0]) => {
      switch (args.method) {
        case 'codemode.learn.status':
          return { ok: true, result: status }
        case 'codemode.learn.list':
          return { ok: true, result: enabled ? list : NONE }
        default:
          return call(args)
      }
    }
  })
}

function Preview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return settings ? (
    <div className="bg-background p-6">
      <CodemodeLearnSection settings={settings} updateSettings={updateSettings} />
    </div>
  ) : null
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

async function clickButton(text: string): Promise<void> {
  await settle()
  ;[...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
    ?.click()
  await settle()
}

export const off = defineFixture({
  width: 820,
  setup: () => stubLearn(false, 0, 0, NONE),
  render: () => <Preview />
})

export const offWithData = defineFixture({
  width: 820,
  setup: () => stubLearn(false, 37, 4_404_019, NONE),
  render: () => <Preview />
})

export const empty = defineFixture({
  width: 820,
  setup: () => stubLearn(true, 3, 98_304, NONE),
  render: () => <Preview />
})

export const list = defineFixture({
  width: 820,
  setup: () => stubLearn(true, 128, 12_897_484, LIST),
  render: () => <Preview />,
  interact: () => clickButton('Sample code')
})

export const clearConfirm = defineFixture({
  width: 820,
  setup: () => stubLearn(true, 128, 12_897_484, LIST),
  render: () => <Preview />,
  interact: () => clickButton('Clear')
})

export const narrow = defineFixture({
  width: 420,
  setup: () => stubLearn(true, 128, 12_897_484, LIST),
  render: () => <Preview />
})
