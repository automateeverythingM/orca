import { vi } from 'vitest'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalsView
} from '../../../../../shared/codemode/codemode-learn-types'
import type { CodemodeLearnRunner } from '../../../../codemode/learn/codemode-learn-pipeline'
import type { CodemodeLearnRemote } from '../../../../codemode/learn/store/codemode-learn-ops'
import { draftReply, SIGNAL_NOW } from '../../../../codemode/learn/testing/learn-signal-fixtures'
import type { LearnWriterGenerate } from '../../../../codemode/learn/writer/codemode-learn-writer'
import {
  draftToLibFile,
  parseWriterReply
} from '../../../../codemode/learn/writer/codemode-learn-writer-reply'
import type { CodemodeLibRecords } from '../../../../codemode/lib/codemode-lib-access'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { requireKnownProject } from './codemode-lib'
import { codemodeLearnMethods } from './codemode-learn'
import { codemodeLearnProposalMethods } from './codemode-learn-proposals'

export type ProposalRpcDeps = {
  learnEnabled: () => boolean
  remote: () => CodemodeLearnRemote
  runner: () => CodemodeLearnRunner
  records: () => CodemodeLibRecords
  generate: () => LearnWriterGenerate
  root: () => string
  workerPath: string
}

/** Calls the Learn and proposal RPC methods by name, the way the router does. */
export function proposalRpc(deps: ProposalRpcDeps) {
  const service = {
    learnEnabled: () => deps.learnEnabled(),
    learnStore: () => deps.remote(),
    learnRunner: () => deps.runner(),
    libRecords: () => deps.records(),
    closeLearnStore: async () => {}
  }
  const learn = codemodeLearnMethods({
    desktop: () => true,
    service: async () => service,
    storeExists: async () => true,
    removeStoreFiles: async () => {},
    journal: async () => null,
    now: () => SIGNAL_NOW + 5,
    log: vi.fn()
  })
  const proposals = codemodeLearnProposalMethods({
    desktop: () => true,
    service: async () => service,
    chains: async () => [],
    generate: () => deps.generate(),
    projectAccess: (_ctx, projectRoot) =>
      requireKnownProject(async () => ({ worktrees: [{ path: deps.root() }] }), projectRoot),
    now: () => SIGNAL_NOW + 5,
    log: vi.fn(),
    workerPath: deps.workerPath
  })
  const ctx: RpcContext = { runtime: new OrcaRuntimeService(null) }
  return async (name: string, params?: unknown): Promise<unknown> => {
    const method = [...eraseRpcMethods(learn), ...eraseRpcMethods(proposals)].find(
      (m) => m.name === name
    )
    if (!method) {
      throw new Error(`no method ${name}`)
    }
    return await method.handler(method.params?.parse(params) ?? params, ctx)
  }
}

export type ProposalCall = ReturnType<typeof proposalRpc>

export const isView = (value: unknown): value is CodemodeLearnProposalsView =>
  typeof value === 'object' && value !== null && 'proposals' in value && 'usage' in value

export async function view(call: ProposalCall): Promise<CodemodeLearnProposalsView> {
  const result = await call('codemode.learn.proposals')
  if (!isView(result)) {
    throw new Error('not a proposals view')
  }
  return result
}

/** A ready, passed proposal for signal `i`, as a finished run leaves it. */
export async function makeReadyProposal(
  remote: CodemodeLearnRemote,
  i: number,
  projectRoot: string | null
): Promise<CodemodeLearnProposal> {
  const parsed = parseWriterReply(draftReply(i))
  if (!parsed.ok) {
    throw new Error(parsed.reason)
  }
  const { draft } = parsed
  const made = (await remote.createProposal(
    { sourceKind: 'script', sourceKey: `k${i}`, sourceSessions: 2, projectRoot, callsBefore: 2 },
    SIGNAL_NOW
  ))!
  await remote.updateProposal(
    made.id,
    { state: 'ready', name: draft.name, description: draft.description, params: draft.params },
    ['writing']
  )
  await remote.updateProposal(made.id, { source: draftToLibFile(draft).source }, ['ready'])
  return (await remote.proposal(made.id))!
}
