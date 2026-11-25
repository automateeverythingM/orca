import {
  CODEMODE_RUN_LIMITS,
  type CodemodeInnerCallRecord,
  type CodemodeRunHeader,
  type CodemodeRunRecord,
  type CodemodeRunsEvent
} from '../../../shared/codemode/codemode-run-wire'
import type { CodemodeRunEvent, InnerCallEvent } from '../host/codemode-run-host'
import { trimOutput } from '../sandbox/codemode-output-trim'

type Listener = (event: CodemodeRunsEvent) => void

function inputText(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    text = String(input)
  }
  return trimOutput(text, CODEMODE_RUN_LIMITS.inputBytes)
}

function header(run: CodemodeRunRecord): CodemodeRunHeader {
  const { calls: _calls, ...rest } = run
  return rest
}

/** Each session's latest run_js runs, bounded for display; a session's end forgets them. */
export class CodemodeRunStore {
  private readonly sessions = new Map<string, CodemodeRunRecord[]>()
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(private readonly now: () => number = Date.now) {}

  runs(sessionId: string): CodemodeRunRecord[] {
    return (this.sessions.get(sessionId) ?? []).map((run) => ({ ...run, calls: [...run.calls] }))
  }

  /** The listener first receives the current runs, then each change. */
  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<Listener>()
    this.listeners.set(sessionId, listeners.add(listener))
    listener({ type: 'snapshot', sessionId, runs: this.runs(sessionId) })
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && this.listeners.get(sessionId) === listeners) {
        this.listeners.delete(sessionId)
      }
    }
  }

  run(sessionId: string, event: CodemodeRunEvent): void {
    const runs = this.sessions.get(sessionId) ?? []
    let run = runs.find((entry) => entry.runId === event.runId)
    if (!run) {
      if (event.state !== 'running') {
        return
      }
      const code = trimOutput(event.code, CODEMODE_RUN_LIMITS.codeBytes)
      run = {
        runId: event.runId,
        code,
        ...(code === event.code ? {} : { codeTruncated: true as const }),
        state: 'running',
        startedAt: this.now(),
        omittedCalls: 0,
        calls: []
      }
      runs.push(run)
      runs.splice(0, Math.max(0, runs.length - CODEMODE_RUN_LIMITS.runsPerSession))
      this.sessions.set(sessionId, runs)
    } else {
      run.state = event.state
      if (event.ms !== undefined) {
        run.ms = event.ms
      }
    }
    this.publish(sessionId, { type: 'run', sessionId, run: header(run) })
  }

  innerCall(sessionId: string, event: InnerCallEvent): void {
    const run = this.sessions.get(sessionId)?.find((entry) => entry.runId === event.runId)
    if (!run) {
      return
    }
    const index = run.calls.findIndex((entry) => entry.seq === event.seq)
    if (index === -1 && run.calls.length >= CODEMODE_RUN_LIMITS.callsPerRun) {
      if (event.state === 'running') {
        run.omittedCalls += 1
      }
      return
    }
    const call: CodemodeInnerCallRecord = {
      seq: event.seq,
      tool: event.tool,
      input: index === -1 ? inputText(event.input) : run.calls[index].input,
      state: event.state,
      ...(event.ms !== undefined ? { ms: event.ms } : {}),
      ...(event.output !== undefined
        ? { output: trimOutput(event.output, CODEMODE_RUN_LIMITS.outputBytes) }
        : {})
    }
    if (index === -1) {
      run.calls.push(call)
    } else {
      run.calls[index] = call
    }
    this.publish(sessionId, {
      type: 'call',
      sessionId,
      runId: run.runId,
      call,
      omittedCalls: run.omittedCalls
    })
  }

  /** Adds Learn's findings to a run's header; a run no longer kept is left alone. */
  annotate(sessionId: string, runId: string, patch: Pick<CodemodeRunHeader, 'seenInChats'>): void {
    const run = this.sessions.get(sessionId)?.find((entry) => entry.runId === runId)
    if (!run) {
      return
    }
    Object.assign(run, patch)
    this.publish(sessionId, { type: 'run', sessionId, run: header(run) })
  }

  dropSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      this.publish(sessionId, { type: 'snapshot', sessionId, runs: [] })
    }
  }

  private publish(sessionId: string, event: CodemodeRunsEvent): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener(event)
      } catch {
        // One broken stream must not stop the others.
      }
    }
  }
}

let processStore: CodemodeRunStore | null = null

/** The process's one store: the code-mode service writes it and the runs stream reads it. */
export function processCodemodeRunStore(): CodemodeRunStore {
  return (processStore ??= new CodemodeRunStore())
}
