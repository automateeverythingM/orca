// Learn: what code mode remembers about past runs, to spot work the agent repeats across chats.

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
