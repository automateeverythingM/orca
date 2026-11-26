import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalsView
} from '../../../../../shared/codemode/codemode-learn-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CodemodeLearnProposals } from './CodemodeLearnProposals'

const SOURCE = `/**
 * @description Finds a CRM user by email, adds them to a group and gives them credits.
 * @param {string} email
 * @param {string} group
 * @param {number} amount
 * @saved-by learn
 */
async function addCreditsToUser({ email, group, amount }) {
  const user = JSON.parse(await mcp['fake-crm'].find_user({ email }))
  await mcp['fake-crm'].add_to_group({ user_id: user.id, group })
  return JSON.parse(await mcp['fake-crm'].add_credits({ user_id: user.id, amount }))
}
`
const LOG = `mcp.fake-crm.find_user {"email":"dana@example.com"} → recorded
mcp.fake-crm.add_to_group {"user_id":"u1","group":"beta"} → recorded
mcp.fake-crm.add_credits {"user_id":"u1","amount":120} → recorded
returned {"id":"u1","credits":120}`

const base: CodemodeLearnProposal = {
  id: 'ready',
  createdAt: Date.now(),
  sourceKind: 'script',
  sourceKey: 'a'.repeat(64),
  sourceSessions: 4,
  projectRoot: '/code/platform',
  state: 'ready',
  name: 'addCreditsToUser',
  description: 'Finds a CRM user by email, adds them to a group and gives them credits.',
  source: SOURCE,
  callsSaved: 2,
  scope: 'project',
  why: 'The same three CRM calls ran in 4 chats with only the email, group and amount changing.',
  testStatus: 'passed',
  testLog: LOG,
  callsBefore: 3
}
const p = (patch: Partial<CodemodeLearnProposal>): CodemodeLearnProposal => ({ ...base, ...patch })

const WRITING = p({
  id: 'writing',
  state: 'writing',
  name: undefined,
  description: undefined,
  source: undefined,
  why: undefined,
  callsSaved: undefined,
  testStatus: undefined,
  testLog: undefined
})
const TESTING = p({
  id: 'testing',
  state: 'testing',
  name: 'syncIssueToPr',
  testStatus: undefined,
  testLog: undefined
})
const FAILED_TEST = p({
  id: 'failed-test',
  name: 'archiveStaleBranches',
  description: 'Lists branches older than 30 days and archives them.',
  testStatus: 'failed',
  testReason: 'unrecorded call: bash',
  testLog: 'bash {"command":"git branch --merged"} → unrecorded call'
})
const WRITER_FAILED = p({
  id: 'writer-failed',
  state: 'failed',
  name: undefined,
  description: undefined,
  source: undefined,
  why: undefined,
  callsSaved: undefined,
  testStatus: undefined,
  testLog: undefined,
  error: 'Claude did not answer within 180 seconds.'
})
const CHAIN = p({
  id: 'chain',
  sourceKind: 'chain',
  sourceSessions: 3,
  projectRoot: null,
  scope: 'global',
  name: 'issueToPullRequest',
  description: 'Reads a Linear issue and opens a GitHub pull request for it.',
  why: 'linear.get_issue → github.create_pull_request ran in 3 chats.',
  testStatus: 'untested',
  testReason: 'direct tool chains have no recorded results',
  testLog: undefined
})
const SAVED = [
  p({
    id: 'saved-1',
    state: 'saved',
    savedAs: { name: 'addCreditsToUser', scope: 'project' },
    savedAt: Date.now()
  }),
  p({
    id: 'saved-2',
    state: 'saved',
    name: 'weeklyReport',
    callsBefore: 7,
    savedAs: { name: 'weeklyReport', scope: 'global' },
    savedAt: Date.now()
  })
]

function stubProposals(view: CodemodeLearnProposalsView): void {
  const call = window.api.runtime.call
  Reflect.set(window.api, 'runtime', {
    ...window.api.runtime,
    call: async (args: Parameters<typeof call>[0]) => {
      switch (args.method) {
        case 'codemode.learn.proposals':
          return { ok: true, result: view }
        case 'codemode.learn.propose':
          return { ok: true, result: { started: true } }
        default:
          return call(args)
      }
    }
  })
}

function Preview(): React.JSX.Element {
  return (
    <div className="bg-background p-6">
      <SettingsGroup id="learn-fixture" title="Learn">
        <CodemodeLearnProposals onChanged={() => {}} />
      </SettingsGroup>
    </div>
  )
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
async function clickAll(text: string): Promise<void> {
  await settle()
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) {
    if (button.textContent?.trim() === text) {
      button.click()
    }
  }
  await settle()
}

const view = (patch: Partial<CodemodeLearnProposalsView>): CodemodeLearnProposalsView => ({
  running: false,
  proposals: [],
  usage: {},
  ...patch
})

export const writing = defineFixture({
  width: 820,
  setup: () => stubProposals(view({ running: true, proposals: [WRITING, TESTING] })),
  render: () => <Preview />
})

export const readyPassed = defineFixture({
  width: 820,
  setup: () => stubProposals(view({ proposals: [base] })),
  render: () => <Preview />,
  interact: () => clickAll('Code')
})

export const failed = defineFixture({
  width: 820,
  setup: () => stubProposals(view({ proposals: [FAILED_TEST, WRITER_FAILED] })),
  render: () => <Preview />,
  interact: () => clickAll('Test log')
})

export const untestedChain = defineFixture({
  width: 820,
  setup: () => stubProposals(view({ proposals: [CHAIN] })),
  render: () => <Preview />
})

export const savedWithStats = defineFixture({
  width: 820,
  setup: () =>
    stubProposals(
      view({
        proposals: SAVED,
        usage: { 'saved-1': { uses: 5, callsAfter: 1 }, 'saved-2': { uses: 1, callsAfter: null } }
      })
    ),
  render: () => <Preview />
})

export const proposeRunning = defineFixture({
  width: 820,
  setup: () => stubProposals(view({ running: true, proposals: [WRITING] })),
  render: () => <Preview />
})

export const editing = defineFixture({
  width: 820,
  setup: () => stubProposals(view({ proposals: [base] })),
  render: () => <Preview />,
  interact: () => clickAll('Edit')
})

export const narrow = defineFixture({
  width: 420,
  setup: () => stubProposals(view({ proposals: [base, CHAIN] })),
  render: () => <Preview />
})
