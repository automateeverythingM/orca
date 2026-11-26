// `codemode.learn.*` for proposals: start a Learn run, list what it drafted, dismiss or save one.
// Desktop only and hidden from `orca.*` (the whole `codemode` area is); each call is the person's
// own action in Settings › Code mode › Learn.
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalState,
  CodemodeLearnProposalUsage,
  CodemodeLearnProposalsView,
  CodemodeLearnProposeResult,
  CodemodeRepeatedChain
} from '../../../../../shared/codemode/codemode-learn-types'
import type { CodemodeLibScope } from '../../../../../shared/codemode/codemode-lib-types'
import {
  CodemodeLearnProposalId,
  CodemodeLearnPropose,
  CodemodeLearnSaveProposal
} from '../../../../../shared/rpc-contract/codemode/codemode-learn-params'
import type { CodemodeService } from '../../../../codemode/codemode-service'
import { runLearn } from '../../../../codemode/learn/codemode-learn-pipeline'
import type { CodemodeLearnRemote } from '../../../../codemode/learn/store/codemode-learn-ops'
import type { LearnWriterGenerate } from '../../../../codemode/learn/writer/codemode-learn-writer'
import { createLearnWriterGenerate } from '../../../../codemode/learn/writer/codemode-learn-writer-generate'
import { libAccessFor } from '../../../../codemode/lib/codemode-lib-access'
import { parseLibHeader } from '../../../../codemode/lib/codemode-lib-header'
import { CodemodeLibStore, libTrustKey } from '../../../../codemode/lib/codemode-lib-store'
import { defineMethod, type RpcContext } from '../../core'
import { installedService, listedChains, runtimeJournal } from './codemode-learn'
import { runtimeProjectAccess } from './codemode-lib'

/** Most proposals listed; saved ones are never deleted, so there can be more than the 50 kept. */
const PROPOSALS_LIST_LIMIT = 100
/** "was N calls, now M" shows once the saved function was used this often. */
export const LEARN_CALLS_AFTER_MIN_USES = 3
const NOT_SAVED: CodemodeLearnProposalState[] = ['writing', 'testing', 'ready', 'failed']
const SAVABLE: CodemodeLearnProposalState[] = ['ready', 'failed']

type ProposalService = Pick<
  CodemodeService,
  'learnEnabled' | 'learnStore' | 'learnRunner' | 'libRecords'
>

export type CodemodeLearnProposalMethodDeps = {
  /** Code mode runs only in the desktop app (its worker and WASM ship only there). */
  desktop: () => boolean
  service: (ctx: RpcContext) => Promise<ProposalService>
  /** The repeated chains as `codemode.learn.list` gives them. */
  chains: (ctx: RpcContext, store: CodemodeLearnRemote) => Promise<CodemodeRepeatedChain[]>
  /** The writer on the person's own Claude login. */
  generate: (ctx: RpcContext) => LearnWriterGenerate
  /** Refuses a root that is not one of Orca's local worktrees. */
  projectAccess: (ctx: RpcContext, projectRoot: string) => Promise<void>
  now: () => number
  log: (message: string, error?: unknown) => void
  /** Tests only; default is the bundled worker entry. */
  workerPath?: string
}

const log = (message: string, error?: unknown): void =>
  console.warn(`[codemode] ${message}`, error ?? '')

const RUNTIME_DEPS: CodemodeLearnProposalMethodDeps = {
  desktop: () => process.versions.electron !== undefined,
  service: installedService,
  chains: async (ctx, store) =>
    (await listedChains({ journal: runtimeJournal, now: Date.now, log }, ctx, store)).chains,
  generate: (ctx) =>
    createLearnWriterGenerate({
      getAgentEnvResolvers: () => ctx.runtime.getCommitMessageAgentEnvironmentResolvers()
    }),
  projectAccess: runtimeProjectAccess,
  now: Date.now,
  log
}

const round1 = (value: number): number => Math.round(value * 10) / 10
const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

/** Why a proposal in this state cannot be saved or dismissed. */
function refusal(state: CodemodeLearnProposalState | undefined): string {
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

async function requireProposal(
  store: CodemodeLearnRemote,
  id: string
): Promise<CodemodeLearnProposal> {
  const proposal = await store.proposal(id)
  if (!proposal) {
    throw new Error('unknown proposal')
  }
  return proposal
}

export function codemodeLearnProposalMethods(deps: CodemodeLearnProposalMethodDeps) {
  const open = async (ctx: RpcContext): Promise<ProposalService> => {
    if (!deps.desktop()) {
      throw new Error('code mode is only available in the desktop app')
    }
    return deps.service(ctx)
  }
  const openEnabled = async (ctx: RpcContext): Promise<ProposalService> => {
    const service = await open(ctx)
    if (!service.learnEnabled()) {
      throw new Error('Learn is off')
    }
    return service
  }

  /** How often a saved proposal's function ran, and its calls per run since it was saved. */
  const usageOf = async (
    service: ProposalService,
    proposal: CodemodeLearnProposal
  ): Promise<CodemodeLearnProposalUsage | null> => {
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

  /** Claims the proposal, then writes its function through the lib store and trusts it; a write
   *  or trust failure gives the proposal back its earlier state. */
  const save = async (
    ctx: RpcContext,
    service: ProposalService,
    proposal: CodemodeLearnProposal,
    scope: CodemodeLibScope,
    edited: string | undefined
  ): Promise<{ name: string; scope: CodemodeLibScope }> => {
    const source = edited ?? proposal.source
    if (!proposal.name || !source) {
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
      // The lib store validates the text (name, definition, size, symlinks) before it writes.
      const saved = await new CodemodeLibStore({ projectRoot, homeDir: records.homeDir }).save({
        name: proposal.name,
        source,
        scope,
        // Why: the person's edited header wins; without one, the writer's description stands.
        description: parseLibHeader(source).meta.description?.trim() || proposal.description,
        savedBy: 'learn'
      })
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

  return [
    defineMethod({
      name: 'codemode.learn.propose',
      permission: 'workspace',
      params: CodemodeLearnPropose,
      handler: async (params, ctx): Promise<CodemodeLearnProposeResult> => {
        const service = await open(ctx)
        if (!service.learnEnabled()) {
          return { started: false, reason: 'Learn is off' }
        }
        const store = service.learnStore()
        const generate = deps.generate(ctx)
        const now = deps.now()
        // Why: the run takes minutes (one writer request per proposal); Settings polls for it.
        const run = service.learnRunner().start((signal) =>
          runLearn(
            {
              store,
              chains: () => deps.chains(ctx, store),
              generate,
              signal,
              enabled: () => service.learnEnabled(),
              log: deps.log,
              ...(deps.workerPath ? { workerPath: deps.workerPath } : {})
            },
            { ...params, now }
          )
        )
        if (!run) {
          return { started: false, reason: 'Learn is already running' }
        }
        void run.catch((error: unknown) => deps.log('a Learn run failed', error))
        return { started: true }
      }
    }),
    defineMethod({
      name: 'codemode.learn.proposals',
      permission: 'workspace',
      params: null,
      handler: async (_params, ctx): Promise<CodemodeLearnProposalsView> => {
        const service = await open(ctx)
        const running = service.learnRunner().running()
        if (!service.learnEnabled()) {
          return { running, proposals: [], usage: {} }
        }
        const proposals = await service.learnStore().proposals(PROPOSALS_LIST_LIMIT)
        const usage: Record<string, CodemodeLearnProposalUsage> = {}
        for (const proposal of proposals) {
          const used = await usageOf(service, proposal)
          if (used) {
            usage[proposal.id] = used
          }
        }
        return { running, proposals, usage }
      }
    }),
    defineMethod({
      name: 'codemode.learn.dismissProposal',
      permission: 'workspace',
      params: CodemodeLearnProposalId,
      handler: async (params, ctx): Promise<Record<string, never>> => {
        const store = (await openEnabled(ctx)).learnStore()
        const moved = await store.updateProposal(params.id, { state: 'dismissed' }, NOT_SAVED)
        const proposal = await requireProposal(store, params.id)
        if (!moved && proposal.state !== 'dismissed') {
          throw new Error(refusal(proposal.state))
        }
        // Why: the repeat is not listed again, and the next run does not draft it again.
        await store.dismiss(proposal.sourceKey)
        return {}
      }
    }),
    defineMethod({
      name: 'codemode.learn.saveProposal',
      permission: 'workspace',
      params: CodemodeLearnSaveProposal,
      handler: async (params, ctx): Promise<{ name: string; scope: CodemodeLibScope }> => {
        const service = await openEnabled(ctx)
        const proposal = await requireProposal(service.learnStore(), params.id)
        if (!SAVABLE.includes(proposal.state)) {
          throw new Error(refusal(proposal.state))
        }
        return save(ctx, service, proposal, params.scope, params.source)
      }
    })
  ]
}

export const CODEMODE_LEARN_PROPOSAL_METHODS = codemodeLearnProposalMethods(RUNTIME_DEPS)
