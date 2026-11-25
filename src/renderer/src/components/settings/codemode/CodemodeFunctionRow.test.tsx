// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CodemodeLibEntryView } from '../../../../../shared/codemode/codemode-lib-types'
import { CodemodeFunctionRow } from './CodemodeFunctionRow'
import * as client from './codemode-lib-client'

vi.mock('./codemode-lib-client', () => ({
  readCodemodeFunction: vi.fn(),
  codemodeFunctionHistory: vi.fn(async () => []),
  trustCodemodeFunction: vi.fn(async () => {}),
  deleteCodemodeFunction: vi.fn(),
  moveCodemodeFunction: vi.fn()
}))

const LISTED = 'a'.repeat(64)
const VIEWED = 'b'.repeat(64)
const fn = (sha256: string): CodemodeLibEntryView => ({
  name: 'addCreditsByEmail',
  description: 'Adds credits',
  params: [],
  savedBy: 'agent',
  scope: 'global',
  uses: 0,
  trusted: false,
  shadowed: false,
  sha256
})
const row = (sha256: string): React.JSX.Element => (
  <CodemodeFunctionRow fn={fn(sha256)} projectRoot={null} onChanged={() => {}} />
)
const allow = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Allow', hidden: true })
const view = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
  })
}

beforeEach(() => {
  vi.mocked(client.readCodemodeFunction).mockResolvedValue({ source: 'return 1', sha256: VIEWED })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('keeps Allow disabled, with its reason, until View read the file', async () => {
  render(row(LISTED))
  expect(allow().disabled).toBe(true)
  expect(allow().getAttribute('title')).toBe('Open View to read it first')
  const hint = document.getElementById(allow().getAttribute('aria-describedby') ?? '')
  expect(hint?.textContent).toBe('Open View to read it first')
  await view()
  expect(allow().disabled).toBe(false)
})

it('trusts the viewed hash, not the listed one', async () => {
  render(row(LISTED))
  await view()
  await act(async () => {
    fireEvent.click(allow())
  })
  expect(client.trustCodemodeFunction).toHaveBeenCalledWith(
    null,
    'addCreditsByEmail',
    'global',
    VIEWED
  )
})

it('stays disabled when the read fails', async () => {
  vi.mocked(client.readCodemodeFunction).mockRejectedValue(new Error('gone'))
  render(row(LISTED))
  await view()
  expect(allow().disabled).toBe(true)
})

it('asks for View again once the listed file changed', async () => {
  const { rerender } = render(row(LISTED))
  await view()
  expect(allow().disabled).toBe(false)
  vi.mocked(client.readCodemodeFunction).mockImplementation(() => new Promise(() => {}))
  rerender(row('c'.repeat(64)))
  expect(allow().disabled).toBe(true)
})
