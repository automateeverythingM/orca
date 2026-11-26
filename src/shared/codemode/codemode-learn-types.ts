// Learn: what code mode remembers about past runs, to spot work the agent repeats across chats.
import type { CodemodeLibParam, CodemodeLibScope } from './codemode-lib-types'

export type CodemodeLearnCall = {
  seq: number
  tool: string
  input: unknown
  ok: boolean
  output?: unknown
  error?: string
  ms: number
  /** Read back only: the stored input was cut (it is the start of its JSON text) or dropped (null). */
  inputTruncated?: true
  /** Read back only: the stored output was cut (it is the start of its JSON text) or dropped (absent). */
  outputTruncated?: true
}

export type CodemodeLearnRun = {
  runId: string
  sessionId: string
  projectRoot: string
  startedAt: number
  ms: number
  ok: boolean
  code: string
  calls: CodemodeLearnCall[]
  /** Read back only: the stored code was cut to its cap. */
  codeTruncated?: true
}

export type CodemodeRepeatedScript = {
  kind: 'script'
  shape: string
  sessions: number
  runs: number
  lastSeen: number
  sampleCode: string
  tools: string[]
  projectRoots: string[]
}

export type CodemodeRepeatedChain = {
  kind: 'chain'
  signature: string
  tools: string[]
  sessions: number
  occurrences: number
  lastSeen: number
}

export type CodemodeLearnStats = {
  runs: number
  calls: number
  /** The store file's size; the write-ahead log is not counted. */
  bytes: number
  oldest: number | null
}

/** `codemode.learn.status`: the switch, and what is stored (zero when the switch is off and no file exists). */
export type CodemodeLearnStatusView = { enabled: boolean; stats: CodemodeLearnStats }

/** `codemode.learn.list`: repeats not dismissed; empty while the switch is off. */
export type CodemodeLearnListView = {
  scripts: CodemodeRepeatedScript[]
  chains: CodemodeRepeatedChain[]
  chainsComputedAt: number | null
}

export type CodemodeLearnProposalState =
  | 'writing'
  | 'testing'
  | 'ready'
  | 'failed'
  | 'saved'
  | 'dismissed'
export type CodemodeLearnTestStatus = 'passed' | 'failed' | 'untested'

/** A function the writer drafted from a repeated script or chain, waiting for the person. */
export type CodemodeLearnProposal = {
  id: string
  createdAt: number
  sourceKind: 'script' | 'chain'
  sourceKey: string
  sourceSessions: number
  projectRoot: string | null
  state: CodemodeLearnProposalState
  error?: string
  name?: string
  description?: string
  params?: CodemodeLibParam[]
  source?: string
  sampleArgs?: unknown
  expect?: string[]
  callsSaved?: number
  scope?: CodemodeLibScope
  why?: string
  testStatus?: CodemodeLearnTestStatus
  testReason?: string
  testLog?: string
  callsBefore: number
  savedAs?: { name: string; scope: CodemodeLibScope }
  savedAt?: number
}

/** What the Learn writer drafted, checked: a function body plus how to test and present it. */
export type CodemodeLearnDraft = {
  name: string
  description: string
  params: CodemodeLibParam[]
  /** The code inside `async function <name>({ <params> }) { … }`. */
  body: string
  /** Arguments taken from one source run, so replay can match its recorded calls. */
  sampleArgs: Record<string, unknown>
  /** 1–3 strings the JSON of the returned value must contain. */
  expect: string[]
  callsSaved: number
  scope: CodemodeLibScope
  why: string
}

/** `codemode.learn.propose` params: only one chat's scripts and/or one shape; a hint for the writer. */
export type CodemodeLearnProposeParams = { sessionId?: string; shape?: string; hint?: string }

/** `codemode.learn.propose`: the run started, or why it did not. */
export type CodemodeLearnProposeResult = { started: true } | { started: false; reason: string }

/** A saved proposal's function in use: `callsAfter` is the average inner calls of recorded runs
 *  that called it, null until it has been used 3 times or while no such run is recorded. */
export type CodemodeLearnProposalUsage = { uses: number; callsAfter: number | null }

/** `codemode.learn.proposals`: newest first; `usage` only for saved ones, by proposal id. */
export type CodemodeLearnProposalsView = {
  running: boolean
  proposals: CodemodeLearnProposal[]
  usage: Record<string, CodemodeLearnProposalUsage>
}
