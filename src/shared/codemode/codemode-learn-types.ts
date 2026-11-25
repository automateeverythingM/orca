// Learn: what code mode remembers about past runs, to spot work the agent repeats across chats.

export type CodemodeLearnCall = {
  seq: number
  tool: string
  input: unknown
  ok: boolean
  output?: unknown
  error?: string
  ms: number
  /** Read back only: the stored input or output was cut to its cap and is its JSON text's start. */
  truncated?: boolean
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
  truncated?: boolean
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
