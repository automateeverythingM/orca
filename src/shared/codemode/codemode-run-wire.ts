/** Streams one session's run_js runs and their inner calls: a snapshot first, then changes. */
export const CODEMODE_RUNS_SUBSCRIBE_METHOD = 'agentSession.subscribeCodemodeRuns'

export const CODEMODE_RUN_LIMITS = {
  runsPerSession: 50,
  callsPerRun: 100,
  codeBytes: 64 * 1024,
  inputBytes: 1024,
  outputBytes: 4 * 1024
} as const

export type CodemodeRunState = 'running' | 'ok' | 'error'

export type CodemodeInnerCallRecord = {
  seq: number
  tool: string
  /** JSON text, cut to `inputBytes` for display. */
  input: string
  state: CodemodeRunState
  ms?: number
  /** Cut to `outputBytes` for display. */
  output?: string
}

export type CodemodeRunHeader = {
  runId: string
  /** The script; when `codeTruncated`, only its head and tail, which matches no call. */
  code: string
  codeTruncated?: true
  state: CodemodeRunState
  /** Host clock. */
  startedAt: number
  ms?: number
  /** Calls past `callsPerRun`, counted but not kept. */
  omittedCalls: number
  /** Learn: chats (this one included) that ran this same script; set only when the agent was nudged. */
  seenInChats?: number
  /** Learn: the script's shape key, set with `seenInChats`; the chat asks Learn about it by this key. */
  shape?: string
}

export type CodemodeRunRecord = CodemodeRunHeader & { calls: CodemodeInnerCallRecord[] }

export type CodemodeRunsEvent =
  | { type: 'snapshot'; sessionId: string; runs: CodemodeRunRecord[] }
  | { type: 'run'; sessionId: string; run: CodemodeRunHeader }
  | {
      type: 'call'
      sessionId: string
      runId: string
      call: CodemodeInnerCallRecord
      omittedCalls: number
    }

/** Applies one event to a session's runs, oldest first, keeping at most `runsPerSession`. */
export function applyCodemodeRunsEvent(
  runs: readonly CodemodeRunRecord[],
  event: CodemodeRunsEvent
): CodemodeRunRecord[] {
  if (event.type === 'snapshot') {
    return event.runs.slice(-CODEMODE_RUN_LIMITS.runsPerSession)
  }
  if (event.type === 'run') {
    const index = runs.findIndex((run) => run.runId === event.run.runId)
    if (index === -1) {
      return [...runs, { ...event.run, calls: [] }].slice(-CODEMODE_RUN_LIMITS.runsPerSession)
    }
    const next = runs.slice()
    next[index] = { ...event.run, calls: runs[index].calls }
    return next
  }
  const index = runs.findIndex((run) => run.runId === event.runId)
  if (index === -1) {
    return runs.slice()
  }
  const run = runs[index]
  const calls = run.calls.filter((call) => call.seq !== event.call.seq)
  calls.push(event.call)
  calls.sort((a, b) => a.seq - b.seq)
  const next = runs.slice()
  next[index] = { ...run, calls, omittedCalls: event.omittedCalls }
  return next
}
