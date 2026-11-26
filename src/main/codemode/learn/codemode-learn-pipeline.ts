// A Learn run, started by the person: picks the top repeated scripts and chains, has the writer
// draft a function for each, replays scripts against their recorded calls, and stores proposals.
// Nothing is saved here; the person saves from Settings. Every update is conditional on the
// proposal's state, so a Dismiss or Save made meanwhile always stands.
import type {
  CodemodeLearnFailure,
  CodemodeLearnProposalState,
  CodemodeLearnRun,
  CodemodeLearnTestStatus,
  CodemodeRepeatedChain,
  CodemodeRepeatedScript
} from '../../../shared/codemode/codemode-learn-types'
import { learnSignalKey, pickSignals, type CodemodeLearnSignal } from './codemode-learn-rank'
import { checkProposalSource, replayProposal } from './replay/codemode-learn-replay'
import type { CodemodeLearnRemote } from './store/codemode-learn-ops'
import type { ProposalPatch } from './store/codemode-learn-proposal-table'
import { WRITER_MAX_RUNS, buildWriterPrompt } from './writer/codemode-learn-writer-prompt'
import { draftToLibFile } from './writer/codemode-learn-writer-reply'
import { runLearnWriter, type LearnWriterGenerate } from './writer/codemode-learn-writer'

export { CodemodeLearnRunner } from './codemode-learn-runner'

/** Most proposals one run drafts. */
export const LEARN_RUN_PROPOSALS = 5
/** Most repeated scripts a run looks through before filtering and ranking. */
const LEARN_RUN_SCRIPTS = 200
export const CHAIN_UNTESTED_REASON = 'direct tool chains have no recorded results'
export const LEARN_STOPPED_REASON = 'Learn stopped before this proposal was finished.'
const UNFINISHED: CodemodeLearnProposalState[] = ['writing', 'testing']

export type LearnPipelineDeps = {
  /** One store for the whole run: after Clear closes it, the old one refuses every call. */
  store: CodemodeLearnRemote
  /** The repeated chains as Settings lists them (refreshed when stale, dismissed ones left out). */
  chains: () => Promise<CodemodeRepeatedChain[]>
  generate: LearnWriterGenerate
  /** Aborted by Clear, by a Learn RPC that finds the switch off, or by the app stopping: the
   *  writer and replay stop, and so does the run. */
  signal: AbortSignal
  /** The Learn switch, read before each step: switched off, the run stops. */
  enabled: () => boolean
  log: (message: string, error?: unknown) => void
  /** Names of the functions already saved for this project root (and global), for the writer to
   *  avoid. Missing or failing, the writer is told none. */
  libNames?: (projectRoot: string | null) => Promise<string[]>
  /** Told how many signals the run will draft, once it has picked them (0: nothing new). */
  onSignals?: (count: number) => void
  /** Tests only; default is the bundled worker entry. */
  workerPath?: string
}

export type LearnRunOptions = {
  /** Only scripts this chat ran. */
  sessionId?: string
  /** Only the script of this shape, or the chain of this signature. */
  shape?: string
  hint?: string
  /** When the run started; a Clear after it refuses the run's proposals. */
  now: number
}

type TestResult = { status: CodemodeLearnTestStatus; reason?: string; log: string }

const round1 = (value: number): number => Math.round(value * 10) / 10
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
const failedWith = (error: string, failure: CodemodeLearnFailure): ProposalPatch => ({
  state: 'failed',
  error,
  failure
})

async function signalsFor(
  deps: LearnPipelineDeps,
  opts: LearnRunOptions
): Promise<CodemodeLearnSignal[]> {
  let scripts: CodemodeRepeatedScript[] = await deps.store.repeatedScripts(
    opts.now,
    LEARN_RUN_SCRIPTS
  )
  // Why: chains are read from chat history by tool name only and carry no chat ids.
  let chains = opts.sessionId === undefined ? await deps.chains() : []
  if (opts.sessionId !== undefined) {
    const shapes = new Set(await deps.store.sessionShapes(opts.sessionId))
    scripts = scripts.filter((script) => shapes.has(script.shape))
  }
  if (opts.shape !== undefined) {
    scripts = scripts.filter((script) => script.shape === opts.shape)
    chains = chains.filter((chain) => chain.signature === opts.shape)
  }
  const skip = new Set(await deps.store.openProposalKeys(opts.now))
  return pickSignals(scripts, chains, skip, LEARN_RUN_PROPOSALS)
}

type Outcome = 'next' | 'stop'

/** Clear (or the app stopping) aborted the run, or the person switched Learn off. */
const stopped = (deps: LearnPipelineDeps): boolean => deps.signal.aborted || !deps.enabled()

async function takenNames(deps: LearnPipelineDeps, projectRoot: string | null): Promise<string[]> {
  try {
    return (await deps.libNames?.(projectRoot)) ?? []
  } catch (error) {
    deps.log('Learn could not read the saved function names', error)
    return []
  }
}

/** A chain has no recordings to replay, but its source must still only define its function. */
async function testChain(
  deps: LearnPipelineDeps,
  input: { source: string; name: string }
): Promise<TestResult> {
  const unfit = await checkProposalSource(input, {
    ...(deps.workerPath ? { workerPath: deps.workerPath } : {}),
    signal: deps.signal
  })
  return unfit ?? { status: 'untested', reason: CHAIN_UNTESTED_REASON, log: '' }
}

/** Drafts and tests one signal's proposal; 'stop' once a Clear, an abort or the switch ended the
 *  run. Any error is this signal's alone: it is logged, its proposal failed, and the run goes on. */
async function proposeOne(
  deps: LearnPipelineDeps,
  opts: LearnRunOptions,
  signal: CodemodeLearnSignal,
  created: string[]
): Promise<Outcome> {
  const { store } = deps
  let id: string | null = null
  try {
    const runs: CodemodeLearnRun[] =
      signal.kind === 'script' ? await store.runsForShape(signal.script.shape, WRITER_MAX_RUNS) : []
    const callsBefore =
      signal.kind === 'script'
        ? round1(runs.reduce((sum, run) => sum + run.calls.length, 0) / Math.max(runs.length, 1))
        : signal.chain.tools.length
    const roots = signal.kind === 'script' ? signal.script.projectRoots : []
    // Why: project scope saves into the source runs' root, so it must be the only one.
    const projectRoot = roots.length === 1 ? (roots[0] ?? null) : null
    if (stopped(deps)) {
      return 'stop'
    }
    const proposal = await store.createProposal(
      {
        sourceKind: signal.kind,
        sourceKey: learnSignalKey(signal),
        sourceSessions: signal.kind === 'script' ? signal.script.sessions : signal.chain.sessions,
        projectRoot,
        callsBefore
      },
      opts.now
    )
    if (!proposal) {
      // Why: a Clear came after the run started; it deleted the proposals made so far as well.
      created.length = 0
      return 'stop'
    }
    id = proposal.id
    created.push(id)
    const prompt = buildWriterPrompt(
      signal.kind === 'script'
        ? { kind: 'script', runs }
        : { kind: 'chain', tools: signal.chain.tools },
      opts.hint,
      await takenNames(deps, projectRoot)
    )
    const written = await runLearnWriter(prompt, { generate: deps.generate, signal: deps.signal })
    if (!written.ok || stopped(deps)) {
      const halted = (!written.ok && written.canceled) || stopped(deps)
      const patch =
        halted || written.ok
          ? failedWith(LEARN_STOPPED_REASON, 'error')
          : failedWith(written.reason, written.notWorth ? 'not-worth' : 'error')
      await store.updateProposal(id, patch, ['writing'])
      return halted ? 'stop' : 'next'
    }
    const { draft } = written
    const { source } = draftToLibFile(draft)
    const testing = await store.updateProposal(
      id,
      {
        state: 'testing',
        name: draft.name,
        description: draft.description,
        params: draft.params,
        source,
        sampleArgs: draft.sampleArgs,
        expect: draft.expect,
        callsSaved: draft.callsSaved,
        scope: draft.scope,
        why: draft.why
      },
      ['writing']
    )
    if (!testing) {
      return 'next'
    }
    const test: TestResult =
      signal.kind === 'chain'
        ? await testChain(deps, { source, name: draft.name })
        : await replayProposal(
            { source, name: draft.name, sampleArgs: draft.sampleArgs, expect: draft.expect, runs },
            { ...(deps.workerPath ? { workerPath: deps.workerPath } : {}), signal: deps.signal }
          )
    if (deps.signal.aborted) {
      await store.updateProposal(id, failedWith(LEARN_STOPPED_REASON, 'error'), ['testing'])
      return 'stop'
    }
    await store.updateProposal(
      id,
      {
        state: 'ready',
        testStatus: test.status,
        ...(test.reason !== undefined ? { testReason: test.reason } : {}),
        testLog: test.log
      },
      ['testing']
    )
    return 'next'
  } catch (error) {
    deps.log(`Learn could not finish a proposal for ${learnSignalKey(signal)}`, error)
    if (id !== null) {
      await store
        .updateProposal(id, failedWith(messageOf(error), 'error'), UNFINISHED)
        .catch(() => false)
    }
    return stopped(deps) ? 'stop' : 'next'
  }
}

/** One Learn run; resolves with the ids of the proposals it created. */
export async function runLearn(
  deps: LearnPipelineDeps,
  opts: LearnRunOptions
): Promise<{ proposals: string[] }> {
  const created: string[] = []
  // Why: runs are single-flight, so a proposal still writing or testing was left by a run that
  // ended without finishing (the app quit); it would otherwise block its source forever.
  for (const left of await deps.store.proposals(100)) {
    if (UNFINISHED.includes(left.state)) {
      await deps.store.updateProposal(
        left.id,
        failedWith(LEARN_STOPPED_REASON, 'error'),
        UNFINISHED
      )
    }
  }
  const signals = await signalsFor(deps, opts)
  deps.onSignals?.(signals.length)
  for (const signal of signals) {
    if (stopped(deps)) {
      break
    }
    if ((await proposeOne(deps, opts, signal, created)) === 'stop') {
      break
    }
  }
  return { proposals: created }
}
