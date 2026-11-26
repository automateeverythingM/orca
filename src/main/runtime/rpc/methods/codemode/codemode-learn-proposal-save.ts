// Saving a Learn proposal and reading a saved one's use, for `codemode.learn.*` in
// codemode-learn-proposals.ts. Saving is the person's approval in Settings.
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalState,
  CodemodeLearnProposalUsage
} from '../../../../../shared/codemode/codemode-learn-types'
import {
  CODEMODE_LIB_NAME,
  CODEMODE_LIB_RESERVED,
  type CodemodeLibScope
} from '../../../../../shared/codemode/codemode-lib-types'
import type { CodemodeService } from '../../../../codemode/codemode-service'
import { libAccessFor } from '../../../../codemode/lib/codemode-lib-access'
import {
  declaredFunctionNames,
  definesFunction,
  parseLibHeader,
  renameFunctionDeclaration
} from '../../../../codemode/lib/codemode-lib-header'
import {
  CodemodeLibStore,
  libTrustKey,
  type CodemodeLibSaveInput
} from '../../../../codemode/lib/codemode-lib-store'
import type { RpcContext } from '../../core'

/** "was N calls, now M" shows once the saved function was used this often. */
export const LEARN_CALLS_AFTER_MIN_USES = 3
/** Most saved function names the writer is told about. */
const LIB_NAMES_MAX = 100
export const SAVABLE: CodemodeLearnProposalState[] = ['ready', 'failed']

export type ProposalService = Pick<
  CodemodeService,
  'learnEnabled' | 'learnStore' | 'learnRunner' | 'libRecords'
>

export type ProposalSaveDeps = {
  /** Refuses a root that is not one of Orca's local worktrees. */
  projectAccess: (ctx: RpcContext, projectRoot: string) => Promise<void>
  now: () => number
  log: (message: string, error?: unknown) => void
}

const round1 = (value: number): number => Math.round(value * 10) / 10
const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

/** Why a proposal in this state cannot be saved or dismissed. */
export function refusal(state: CodemodeLearnProposalState | undefined): string {
  if (state === undefined) {
    return 'unknown proposal'
  }
  if (state === 'saved') {
    return 'This proposal is already saved.'
  }
  return state === 'dismissed'
    ? 'This proposal was dismissed.'
    : 'This proposal is not ready to save yet.'
}

/**
 * Resolves the name and source to save: changing either `@name` or the function declaration alone
 * renames the function (keeping header and declaration aligned); changing them to different names
 * is left mismatched so validation rejects it.
 */
function resolveProposalEdit(
  proposal: CodemodeLearnProposal,
  edited: string | undefined
): { name: string | null; source: string | null } {
  const original = proposal.name ?? null
  if (edited === undefined) {
    return { name: original, source: proposal.source ?? null }
  }
  const { meta, body } = parseLibHeader(edited)
  const headerName = meta.name?.trim() || null
  if (headerName && headerName !== original) {
    if (definesFunction(body, headerName)) {
      return { name: headerName, source: edited }
    }
    if (
      original &&
      CODEMODE_LIB_NAME.test(headerName) &&
      !CODEMODE_LIB_RESERVED.has(headerName) &&
      definesFunction(body, original)
    ) {
      const header = edited.slice(0, edited.length - body.length)
      return {
        name: headerName,
        source: header + renameFunctionDeclaration(body, original, headerName)
      }
    }
    return { name: headerName, source: edited }
  }
  if (original && definesFunction(body, original)) {
    return { name: original, source: edited }
  }
  const prior = new Set(
    proposal.source ? declaredFunctionNames(parseLibHeader(proposal.source).body) : []
  )
  const added = declaredFunctionNames(body).filter((fn) => fn !== original && !prior.has(fn))
  if (added.length === 1) {
    return { name: added[0], source: edited }
  }
  return { name: original, source: edited }
}

/** Names of the functions saved in `projectRoot` (a known worktree only) and globally. */
export async function savedLibNames(
  deps: ProposalSaveDeps,
  ctx: RpcContext,
  service: ProposalService,
  projectRoot: string | null
): Promise<string[]> {
  const records = service.libRecords()
  let store = new CodemodeLibStore({ projectRoot: null, homeDir: records.homeDir })
  if (projectRoot) {
    try {
      await deps.projectAccess(ctx, projectRoot)
      store = (await libAccessFor(projectRoot, records)).store
    } catch {
      // Not a known worktree: only the global names apply.
    }
  }
  const { functions } = await store.list()
  return functions.map((fn) => fn.name).slice(0, LIB_NAMES_MAX)
}

/** Claims the proposal, then writes its function through the lib store and trusts it; a write
 *  or trust failure, or a function of that name already in the scope, gives the proposal back its
 *  earlier state. */
export async function saveLearnProposal(
  deps: ProposalSaveDeps,
  ctx: RpcContext,
  service: ProposalService,
  proposal: CodemodeLearnProposal,
  scope: CodemodeLibScope,
  edited: string | undefined
): Promise<{ name: string; scope: CodemodeLibScope }> {
  const { name, source } = resolveProposalEdit(proposal, edited)
  if (!name || !source) {
    throw new Error('This proposal has no function to save.')
  }
  const records = service.libRecords()
  let projectRoot: string | null = null
  if (scope === 'project') {
    if (!proposal.projectRoot) {
      throw new Error('This proposal has no project to save into; save it as global.')
    }
    await deps.projectAccess(ctx, proposal.projectRoot)
    projectRoot = (await libAccessFor(proposal.projectRoot, records)).projectRoot
  }
  const store = service.learnStore()
  // Why: claimed before anything is written, so a Dismiss or a second Save meanwhile is refused.
  if (!(await store.updateProposal(proposal.id, { state: 'saved' }, SAVABLE))) {
    throw new Error(refusal((await store.proposal(proposal.id))?.state))
  }
  try {
    const lib = new CodemodeLibStore({ projectRoot, homeDir: records.homeDir })
    const input: CodemodeLibSaveInput = {
      name,
      source,
      scope,
      // Why: the person's edited header wins; without one, the writer's description stands.
      description: parseLibHeader(source).meta.description?.trim() || proposal.description,
      savedBy: 'learn'
    }
    // The lib store validates the text (name, definition, size, symlinks) before it writes.
    if ((await lib.prepare(input)).exists) {
      // Why: saving would replace the person's function (into its history) without asking.
      throw new Error(
        `A function named ${name} already exists in ${scope}. Edit the name or delete the existing one.`
      )
    }
    const saved = await lib.save(input)
    // Why: the person read and approved this exact text in Settings.
    await records.trust.record(await libTrustKey(scope, projectRoot), saved.name, saved.source)
    const savedAs = { name: saved.name, scope }
    const fields = { savedAs, savedAt: deps.now(), source: saved.source }
    await store.updateProposal(proposal.id, fields, ['saved'])
    return savedAs
  } catch (error) {
    await store
      .updateProposal(proposal.id, { state: proposal.state }, ['saved'])
      .catch((revert: unknown) => deps.log('Learn could not give a proposal back', revert))
    throw error
  }
}

/** How often a saved proposal's function ran, and its calls per run since it was saved. */
export async function learnProposalUsage(
  deps: Pick<ProposalSaveDeps, 'log'>,
  service: ProposalService,
  proposal: CodemodeLearnProposal
): Promise<CodemodeLearnProposalUsage | null> {
  const saved = proposal.savedAs
  if (proposal.state !== 'saved' || !saved) {
    return null
  }
  const root = saved.scope === 'project' ? proposal.projectRoot : null
  try {
    const key = await libTrustKey(saved.scope, root)
    const { uses } = await service.libRecords().usage.read(key, saved.name)
    const after =
      uses >= LEARN_CALLS_AFTER_MIN_USES
        ? await service.learnStore().libCallsAfter(saved.name, proposal.savedAt ?? 0, root)
        : null
    return { uses, callsAfter: after === null ? null : round1(after) }
  } catch (error) {
    // A project folder that is gone has no usage to show; anything else is worth a log line.
    if (!isMissing(error)) {
      deps.log(`Learn could not read the usage of ${saved.name}`, error)
    }
    return { uses: 0, callsAfter: null }
  }
}
