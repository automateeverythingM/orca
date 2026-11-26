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
import { runLearn } from '../../../../codemode/learn/codemode-learn-pipeline'
import type { CodemodeLearnRemote } from '../../../../codemode/learn/store/codemode-learn-ops'
import type { ProposalPatch } from '../../../../codemode/learn/store/codemode-learn-proposal-table'
import type { LearnWriterGenerate } from '../../../../codemode/learn/writer/codemode-learn-writer'
import { createLearnWriterGenerate } from '../../../../codemode/learn/writer/codemode-learn-writer-generate'
import { defineMethod, type RpcContext } from '../../core'
import { installedService, learnSwitch, listedChains, runtimeJournal } from './codemode-learn'
import { runtimeProjectAccess } from './codemode-lib'
import {
  SAVABLE,
  learnProposalUsage,
  refusal,
  saveLearnProposal,
  savedLibNames,
  type ProposalService
} from './codemode-learn-proposal-save'

export { LEARN_CALLS_AFTER_MIN_USES } from './codemode-learn-proposal-save'

/** Most proposals listed; saved ones are never deleted, so there can be more than the 50 kept. */
const PROPOSALS_LIST_LIMIT = 100
const NOT_SAVED: CodemodeLearnProposalState[] = ['writing', 'testing', 'ready', 'failed']
const UNFINISHED: CodemodeLearnProposalState[] = ['writing', 'testing']
export const LEARN_NOTHING_NEW_REASON = 'Nothing new to learn here yet.'
/** A proposal still writing or testing while no run goes: the app quit or the run crashed. */
const SWEPT: ProposalPatch = {
  state: 'failed',
  error: 'Stopped before it finished.',
  failure: 'error'
}

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

/** A card that failed on a writer or run error says nothing about the repeat itself. */
const failedOnError = (proposal: CodemodeLearnProposal): boolean =>
  proposal.failure === 'error' || (proposal.state === 'failed' && proposal.failure !== 'not-worth')

/** Proposals as listed; while no run goes, any left writing or testing is marked failed. */
async function listed(service: ProposalService): Promise<CodemodeLearnProposal[]> {
  const store = service.learnStore()
  const proposals = await store.proposals(PROPOSALS_LIST_LIMIT)
  // Why: checked after the read; a run started since may own a proposal this list holds.
  if (service.learnRunner().running()) {
    return proposals
  }
  return Promise.all(
    proposals.map(async (proposal) => {
      if (!UNFINISHED.includes(proposal.state)) {
        return proposal
      }
      if (await store.updateProposal(proposal.id, SWEPT, UNFINISHED)) {
        return { ...proposal, ...SWEPT }
      }
      return (await store.proposal(proposal.id)) ?? proposal
    })
  )
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

  return [
    defineMethod({
      name: 'codemode.learn.propose',
      permission: 'workspace',
      params: CodemodeLearnPropose,
      handler: async (params, ctx): Promise<CodemodeLearnProposeResult> => {
        const service = await open(ctx)
        if (!service.learnEnabled()) {
          return { started: false, code: 'off', reason: 'Learn is off' }
        }
        const store = service.learnStore()
        const generate = deps.generate(ctx)
        const now = deps.now()
        const picked = Promise.withResolvers<number | null>()
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
              libNames: (root) => savedLibNames(deps, ctx, service, root),
              onSignals: (count) => picked.resolve(count),
              ...(deps.workerPath ? { workerPath: deps.workerPath } : {})
            },
            { ...params, now }
          )
        )
        if (!run) {
          return { started: false, code: 'running', reason: 'Learn is already running' }
        }
        void run
          .catch((error: unknown) => deps.log('a Learn run failed', error))
          .finally(() => picked.resolve(null))
        // Why: answers once the run has picked its signals, so "nothing new" is said, not polled.
        const count = await picked.promise
        if (count === 0) {
          return { started: false, code: 'nothing-new', reason: LEARN_NOTHING_NEW_REASON }
        }
        if (count === null) {
          // The run failed before it picked anything; its error is the answer.
          await run
        }
        return { started: true }
      }
    }),
    defineMethod({
      name: 'codemode.learn.proposals',
      permission: 'workspace',
      params: null,
      handler: async (_params, ctx): Promise<CodemodeLearnProposalsView> => {
        const service = await open(ctx)
        const enabled = learnSwitch(service)
        const running = service.learnRunner().running()
        if (!enabled) {
          return { running, proposals: [], usage: {} }
        }
        const proposals = await listed(service)
        const usage: Record<string, CodemodeLearnProposalUsage> = {}
        for (const proposal of proposals) {
          const used = await learnProposalUsage(deps, service, proposal)
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
        const before = await requireProposal(store, params.id)
        const moved = await store.updateProposal(params.id, { state: 'dismissed' }, NOT_SAVED)
        if (!moved) {
          const now = await requireProposal(store, params.id)
          if (now.state !== 'dismissed') {
            throw new Error(refusal(now.state))
          }
        }
        // Why: the repeat is not listed again, and the next run does not draft it again; a card
        // that failed on an error only goes, so a later run may still draft that repeat.
        if (!failedOnError(before)) {
          await store.dismiss(before.sourceKey)
        }
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
        return saveLearnProposal(deps, ctx, service, proposal, params.scope, params.source)
      }
    })
  ]
}

export const CODEMODE_LEARN_PROPOSAL_METHODS = codemodeLearnProposalMethods(RUNTIME_DEPS)
