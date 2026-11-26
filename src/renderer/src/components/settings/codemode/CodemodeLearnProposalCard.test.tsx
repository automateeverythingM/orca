// @vitest-environment happy-dom

import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as client from './codemode-learn-client'
import {
  answer,
  base,
  button,
  click,
  onChanged,
  proposal,
  resetProposalTests,
  show,
  SOURCE
} from './codemode-learn-proposals-test-kit'

vi.mock('./codemode-learn-client', async (importActual) => ({
  ...(await importActual<typeof client>()),
  codemodeLearnProposals: vi.fn(),
  proposeCodemodeLearn: vi.fn(async () => ({ started: true })),
  dismissCodemodeProposal: vi.fn(async () => {}),
  saveCodemodeProposal: vi.fn(async () => ({ name: 'addCredits', scope: 'global' }))
}))

afterEach(resetProposalTests)

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

it('Dismiss on a card that failed on an error says Learn may try again', async () => {
  answer({ proposals: [{ ...base, state: 'failed', failure: 'error', error: 'timed out' }] })
  await show()
  await click(button('Dismiss'))
  expect(screen.getByText('Removes this card. A later Learn run may try again.')).toBeTruthy()
  expect(screen.queryByText('Won’t be suggested again.')).toBeNull()
})

it('a save error shows main’s words', async () => {
  answer({ proposals: [base] })
  vi.mocked(client.saveCodemodeProposal).mockRejectedValueOnce(new Error('x'))
  await show()
  await click(button('Save'))
  expect(screen.getByRole('alert').textContent).toBe('Something went wrong. Try again.')
})

it('a blank edit cannot be kept; the code shown is the code saved', async () => {
  answer({ proposals: [base] })
  await show()
  await click(button('Edit'))
  const editor = screen.getByRole('textbox', { name: 'Code for addCredits' })
  await act(async () => {
    fireEvent.change(editor, { target: { value: '  \n ' } })
  })
  expect(button('Done').hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('Code can’t be empty')).toBeTruthy()
  // The replay warning is hidden while editing.
  expect(screen.queryByText(/^Replay checks one recorded case/)).toBeNull()
  const edited = 'async function addCredits({ email }) {\n  return 2\n}\n'
  await act(async () => {
    fireEvent.change(editor, { target: { value: edited } })
  })
  await click(button('Done'))
  expect(screen.getByText(/^Replay checks one recorded case/)).toBeTruthy()
  await click(button('Code'))
  expect(screen.getByTestId('codemode-proposal-p1').querySelector('pre')?.textContent).toBe(edited)
  await click(button('Save'))
  expect(client.saveCodemodeProposal).toHaveBeenCalledWith({
    id: 'p1',
    scope: 'project',
    source: edited
  })
})

it('Save stays disabled while a save is in flight and after it succeeds', async () => {
  answer({ proposals: [base] })
  let finish: () => void = () => {}
  vi.mocked(client.saveCodemodeProposal).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ name: 'addCredits', scope: 'project' })
      })
  )
  // The refreshed list has not come back yet when the save resolves.
  await show()
  vi.mocked(client.codemodeLearnProposals).mockImplementation(() => new Promise(() => {}))
  await click(button('Save'))
  expect(button('Save').hasAttribute('disabled')).toBe(true)
  await act(async () => {
    finish()
  })
  expect(button('Save').hasAttribute('disabled')).toBe(true)
  expect(client.saveCodemodeProposal).toHaveBeenCalledOnce()
})
