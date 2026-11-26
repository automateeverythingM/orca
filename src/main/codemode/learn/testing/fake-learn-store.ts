import { type Mock, vi } from 'vitest'
import type { CodemodeLearnRun } from '../../../../shared/codemode/codemode-learn-types'
import type { CodemodeLearnRemote } from '../store/codemode-learn-ops'

export type Recorded = Awaited<ReturnType<CodemodeLearnRemote['record']>>

/** A Learn store whose `record` the test answers; every other op rejects. */
export function fakeLearnStore(
  record: (run: CodemodeLearnRun, now: number) => Promise<Recorded>
): CodemodeLearnRemote & { record: Mock<CodemodeLearnRemote['record']> } {
  const unused = (): Promise<never> => Promise.reject(new Error('not used in this test'))
  return {
    record: vi.fn(record),
    repeatedScripts: unused,
    runsForShape: unused,
    saveChains: unused,
    chains: unused,
    dismiss: unused,
    dismissed: unused,
    clear: unused,
    compact: unused,
    createProposal: unused,
    updateProposal: unused,
    proposals: unused,
    proposal: unused,
    openProposalKeys: unused,
    stats: unused
  }
}
