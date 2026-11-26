// Shared setup for the Learn proposal tests. Each test file mocks `./codemode-learn-client` itself
// (vi.mock is per file); this kit then sees the mocked module.
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { vi } from 'vitest'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalsView
} from '../../../../../shared/codemode/codemode-learn-types'
import * as client from './codemode-learn-client'
import { CodemodeLearnProposals } from './CodemodeLearnProposals'

export const SOURCE =
  '/**\n * @description Adds credits\n */\nasync function addCredits({ email }) {\n  return 1\n}\n'
export const base: CodemodeLearnProposal = {
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
export const proposal = (patch: Partial<CodemodeLearnProposal>): CodemodeLearnProposal => ({
  ...base,
  ...patch
})

export function answer(view: Partial<CodemodeLearnProposalsView>): void {
  vi.mocked(client.codemodeLearnProposals).mockResolvedValue({
    running: false,
    proposals: [],
    usage: {},
    ...view
  })
}

export const onChanged = vi.fn()
export async function show(): Promise<void> {
  await act(async () => {
    render(<CodemodeLearnProposals onChanged={onChanged} />)
  })
}
export const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(element)
  })
}
export const button = (name: string | RegExp, root: HTMLElement = document.body): HTMLElement =>
  within(root).getByRole('button', { name })

export function resetProposalTests(): void {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
}
