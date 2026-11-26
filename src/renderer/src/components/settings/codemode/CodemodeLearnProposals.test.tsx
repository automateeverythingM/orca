// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalsView
} from '../../../../../shared/codemode/codemode-learn-types'
import * as client from './codemode-learn-client'
import { CodemodeLearnProposals } from './CodemodeLearnProposals'

vi.mock('./codemode-learn-client', async (importActual) => ({
  ...(await importActual<typeof client>()),
  codemodeLearnProposals: vi.fn(),
  proposeCodemodeLearn: vi.fn(async () => ({ started: true })),
  dismissCodemodeProposal: vi.fn(async () => {}),
  saveCodemodeProposal: vi.fn(async () => ({ name: 'addCredits', scope: 'global' }))
}))

const SOURCE =
  '/**\n * @description Adds credits\n */\nasync function addCredits({ email }) {\n  return 1\n}\n'
const base: CodemodeLearnProposal = {
  id: 'p1',
  createdAt: 1,
  sourceKind: 'script',
  sourceKey: 'k1',
  sourceSessions: 3,
  projectRoot: '/repo',
  state: 'ready',
  name: 'addCredits',
  description: 'Adds credits to a CRM user',
  source: SOURCE,
  callsSaved: 2,
  scope: 'project',
  why: 'Ran the same three CRM calls in 3 chats.',
  testStatus: 'passed',
  testLog: 'mcp.crm.find_user → ok',
  callsBefore: 3
}
const proposal = (patch: Partial<CodemodeLearnProposal>): CodemodeLearnProposal => ({
  ...base,
  ...patch
})

function answer(view: Partial<CodemodeLearnProposalsView>): void {
  vi.mocked(client.codemodeLearnProposals).mockResolvedValue({
    running: false,
    proposals: [],
    usage: {},
    ...view
  })
}

const onChanged = vi.fn()
async function show(): Promise<void> {
  await act(async () => {
    render(<CodemodeLearnProposals onChanged={onChanged} />)
  })
}
const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(element)
  })
}
const button = (name: string | RegExp, root: HTMLElement = document.body): HTMLElement =>
  within(root).getByRole('button', { name })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('shows each card state', async () => {
  answer({
    proposals: [
      proposal({ id: 'w', state: 'writing', name: undefined, source: undefined }),
      proposal({ id: 't', state: 'testing', name: 'tested' }),
      proposal({ id: 'r', name: 'passing' }),
      proposal({
        id: 'f',
        name: 'failing',
        testStatus: 'failed',
        testReason: 'unrecorded call: mcp.x'
      }),
      proposal({
        id: 'c',
        name: 'chained',
        sourceKind: 'chain',
        sourceSessions: 2,
        projectRoot: null,
        testStatus: 'untested',
        testReason: 'direct tool chains have no recorded results'
      }),
      proposal({
        id: 'e',
        state: 'failed',
        name: undefined,
        source: undefined,
        error: 'Claude timed out'
      })
    ]
  })
  await show()
  expect(screen.getByText('Writing a function…')).toBeTruthy()
  expect(screen.getByText('Testing against recorded results…')).toBeTruthy()
  expect(screen.getByText('Passed')).toBeTruthy()
  expect(screen.getByText('Failed: unrecorded call: mcp.x')).toBeTruthy()
  expect(screen.getByText('Untested: direct tool chains have no recorded results')).toBeTruthy()
  expect(screen.getByText('Tool chain used in 2 chats')).toBeTruthy()
  expect(screen.getAllByText('Script used in 3 chats').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Saves about 2 calls').length).toBeGreaterThan(0)
  expect(screen.getByText('Couldn’t write this function: Claude timed out')).toBeTruthy()
  // Ready-passed, ready-failed and untested cards can be saved, each with the replay warning.
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(3)
  expect(
    screen.getAllByText('Replay checks one recorded case. Read the code before saving.')
  ).toHaveLength(3)
  // The chain has no project, so only global can be picked.
  const chain = screen.getByTestId('codemode-proposal-c')
  expect(within(chain).getByRole('radio', { name: 'Project' }).getAttribute('aria-disabled')).toBe(
    'true'
  )
  expect(within(chain).getByRole('radio', { name: 'Global' }).getAttribute('aria-checked')).toBe(
    'true'
  )
})

it('shows the code and test log on request', async () => {
  answer({ proposals: [base] })
  await show()
  expect(screen.queryByText('mcp.crm.find_user → ok')).toBeNull()
  await click(button('Test log'))
  expect(screen.getByText('mcp.crm.find_user → ok')).toBeTruthy()
  await click(button('Code'))
  expect(screen.getByTestId('codemode-proposal-p1').textContent).toContain(
    'async function addCredits'
  )
})

it('Save sends the chosen scope and the edited source', async () => {
  answer({ proposals: [base] })
  await show()
  await click(button('Edit'))
  const editor = screen.getByRole('textbox', { name: 'Code for addCredits' })
  await act(async () => {
    fireEvent.change(editor, { target: { value: `${SOURCE}// edited\n` } })
  })
  await click(button('Done'))
  await click(screen.getByRole('radio', { name: 'Global' }))
  await click(button('Save'))
  expect(client.saveCodemodeProposal).toHaveBeenCalledWith({
    id: 'p1',
    scope: 'global',
    source: `${SOURCE}// edited\n`
  })
  expect(onChanged).toHaveBeenCalled()
})

it('Save without an edit sends no source; Cancel drops the edit', async () => {
  answer({ proposals: [proposal({ testStatus: 'failed', testReason: 'boom' })] })
  await show()
  await click(button('Edit'))
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Code for addCredits' }), {
      target: { value: 'nope' }
    })
  })
  await click(button('Cancel'))
  await click(button('Save'))
  expect(client.saveCodemodeProposal).toHaveBeenCalledWith({ id: 'p1', scope: 'project' })
})

it('Dismiss says it won’t come back, then dismisses', async () => {
  answer({ proposals: [base] })
  await show()
  await click(button('Dismiss'))
  expect(client.dismissCodemodeProposal).not.toHaveBeenCalled()
  expect(screen.getByText('Won’t be suggested again.')).toBeTruthy()
  await click(screen.getAllByRole('button', { name: 'Dismiss' })[1] ?? document.body)
  expect(client.dismissCodemodeProposal).toHaveBeenCalledWith('p1')
})

it('a save error shows main’s words', async () => {
  answer({ proposals: [base] })
  vi.mocked(client.saveCodemodeProposal).mockRejectedValueOnce(new Error('x'))
  await show()
  await click(button('Save'))
  expect(screen.getByRole('alert').textContent).toBe('Something went wrong. Try again.')
})

it('saved proposals move to Saved by Learn with their stats', async () => {
  answer({
    proposals: [
      proposal({
        id: 's1',
        state: 'saved',
        name: 'addCredits',
        savedAs: { name: 'addCredits', scope: 'project' }
      }),
      proposal({
        id: 's2',
        state: 'saved',
        name: 'newOne',
        savedAs: { name: 'newOne', scope: 'global' }
      })
    ],
    usage: { s1: { uses: 4, callsAfter: 1.5 }, s2: { uses: 1, callsAfter: null } }
  })
  await show()
  expect(screen.getByText('Saved by Learn')).toBeTruthy()
  expect(screen.getByText(/was 3 calls, now 1\.5/)).toBeTruthy()
  expect(screen.getAllByText(/was \d/)).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
})

it('Find functions to save sends the hint and is disabled while Learn runs', async () => {
  answer({ running: false })
  await show()
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText('What should Learn look for? (optional)'), {
      target: { value: ' crm credits ' }
    })
  })
  answer({ running: true })
  await click(button('Find functions to save'))
  expect(client.proposeCodemodeLearn).toHaveBeenCalledWith({ hint: 'crm credits' })
  const running = button('Learning…')
  expect(running.hasAttribute('disabled')).toBe(true)
})

it('polls every 2 seconds while a run is going, and stops after', async () => {
  vi.useFakeTimers()
  answer({ running: true, proposals: [proposal({ state: 'writing' })] })
  await show()
  const calls = (): number => vi.mocked(client.codemodeLearnProposals).mock.calls.length
  expect(calls()).toBe(1)
  answer({ running: false, proposals: [base] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(calls()).toBe(2)
  expect(screen.getByText('Passed')).toBeTruthy()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000)
  })
  expect(calls()).toBe(2)
})

it('a refused run says why', async () => {
  answer({})
  vi.mocked(client.proposeCodemodeLearn).mockResolvedValueOnce({
    started: false,
    reason: 'Learn is off'
  })
  await show()
  await click(button('Find functions to save'))
  expect(screen.getByRole('alert').textContent).toBe('Learn is off')
})
