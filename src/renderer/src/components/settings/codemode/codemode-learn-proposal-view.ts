// What the Learn proposal cards decide without React: grouping, what can be saved, where, and with
// which source.
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposeParams
} from '../../../../../shared/codemode/codemode-learn-types'
import type { CodemodeLibScope } from '../../../../../shared/codemode/codemode-lib-types'

/** Main accepts a hint of at most this many characters (it cuts it to 500 for the writer). */
const HINT_MAX = 2000

/** Open proposals (still being written, or waiting for the person) and saved ones; dismissed go. */
export function splitProposals(proposals: readonly CodemodeLearnProposal[]): {
  open: CodemodeLearnProposal[]
  saved: CodemodeLearnProposal[]
} {
  return {
    open: proposals.filter((p) => p.state !== 'saved' && p.state !== 'dismissed'),
    saved: proposals.filter((p) => p.state === 'saved')
  }
}

/** Main saves only a ready or failed proposal, and only one that has a function to save. */
export function canSaveProposal(proposal: CodemodeLearnProposal): boolean {
  return (proposal.state === 'ready' || proposal.state === 'failed') && Boolean(proposal.source)
}

/** The writer's suggested scope; global when the source runs had no single project root. */
export function defaultSaveScope(proposal: CodemodeLearnProposal): CodemodeLibScope {
  return proposal.projectRoot !== null && proposal.scope !== 'global' ? 'project' : 'global'
}

/** The person's edit, sent exactly as the card shows it, and only when it changes the file. */
export function editedSource(
  proposal: CodemodeLearnProposal,
  edit: string | null
): string | undefined {
  if (edit === null || edit === proposal.source) {
    return undefined
  }
  return edit
}

/** `codemode.learn.propose` params for the Settings button: the hint when there is one. */
export function proposeParams(hint: string): CodemodeLearnProposeParams {
  const text = hint.trim().slice(0, HINT_MAX)
  return text ? { hint: text } : {}
}
