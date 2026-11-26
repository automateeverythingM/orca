// @vitest-environment happy-dom

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as client from './codemode-learn-client'
import {
  answer,
  base,
  button,
  click,
  proposal,
  resetProposalTests,
  show
} from './codemode-learn-proposals-test-kit'

vi.mock('./codemode-learn-client', async (importActual) => ({
  ...(await importActual<typeof client>()),
  codemodeLearnProposals: vi.fn(),
  proposeCodemodeLearn: vi.fn(async () => ({ started: true })),
  dismissCodemodeProposal: vi.fn(async () => {}),
  saveCodemodeProposal: vi.fn(async () => ({ name: 'addCredits', scope: 'global' }))
}))

afterEach(resetProposalTests)

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
    code: 'off',
    reason: 'Learn is off'
  })
  await show()
  await click(button('Find functions to save'))
  expect(screen.getByRole('alert').textContent).toBe('Learn is off')
})

it('a failed read during a run keeps polling and shows the error', async () => {
  vi.useFakeTimers()
  answer({ running: true, proposals: [proposal({ state: 'writing' })] })
  await show()
  vi.mocked(client.codemodeLearnProposals).mockRejectedValueOnce(new Error('x'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(screen.getByRole('alert').textContent).toBe('Something went wrong. Try again.')
  expect(button('Learning…')).toBeTruthy()
  answer({ running: false, proposals: [base] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(vi.mocked(client.codemodeLearnProposals).mock.calls.length).toBe(3)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(button('Find functions to save')).toBeTruthy()
})

it('unmounting stops the poll', async () => {
  vi.useFakeTimers()
  answer({ running: true })
  await show()
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(client.codemodeLearnProposals).toHaveBeenCalledOnce()
})

it('an already running Learn is polled, by its code', async () => {
  answer({ running: false })
  vi.mocked(client.proposeCodemodeLearn).mockResolvedValueOnce({
    started: false,
    code: 'running',
    reason: 'anything'
  })
  await show()
  answer({ running: true })
  await click(button('Find functions to save'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(button('Learning…').hasAttribute('disabled')).toBe(true)
})

it('a saved function not used yet says nothing about use', async () => {
  answer({
    proposals: [
      proposal({ id: 's', state: 'saved', savedAs: { name: 'addCredits', scope: 'global' } })
    ],
    usage: { s: { uses: 0, callsAfter: null } }
  })
  await show()
  expect(screen.getByText('Saved as global')).toBeTruthy()
})
