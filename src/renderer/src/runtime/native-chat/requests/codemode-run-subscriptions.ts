import { subscribeRuntimeRpc } from '../../rpc/subscriptions/runtime-rpc-subscribe'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  applyCodemodeRunsEvent,
  CODEMODE_RUNS_SUBSCRIBE_METHOD,
  type CodemodeRunRecord,
  type CodemodeRunsEvent
} from '../../../../../shared/codemode/codemode-run-wire'
import { matchRunToCall } from '../../../../../shared/codemode/codemode-run-match'

const RESUBSCRIBE_MS = 2000

export type CodemodeWatchedCall = { callId: string; code: string | null; running: boolean }

type Entry = {
  target: RuntimeClientTarget
  sessionId: string
  runs: CodemodeRunRecord[]
  /** callId → runId; a pairing, once made, is kept while the run is. */
  matches: Map<string, string>
  /** The session's mounted run_js rows, in mount order. */
  calls: Map<string, CodemodeWatchedCall>
  listeners: Set<() => void>
  version: number
  stop: (() => void) | null
  retry: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()

export function codemodeRunsKey(target: RuntimeClientTarget, sessionId: string): string {
  return `${target.kind === 'environment' ? target.environmentId : 'local'}\u0000${sessionId}`
}

function entryFor(target: RuntimeClientTarget, sessionId: string): Entry {
  const key = codemodeRunsKey(target, sessionId)
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      target,
      sessionId,
      runs: [],
      matches: new Map(),
      calls: new Map(),
      listeners: new Set(),
      version: 0,
      stop: null,
      retry: null
    }
    entries.set(key, entry)
  }
  return entry
}

function candidates(entry: Entry, running: boolean) {
  return [...entry.calls.values()]
    .filter((call) => call.running === running && call.code !== null)
    .map((call) => ({ callId: call.callId, name: 'orca/run_js', input: { code: call.code } }))
}

/** Live runs pair with running calls oldest first; settled runs with settled calls newest first. */
function rematch(entry: Entry): void {
  const runIds = new Set(entry.runs.map((run) => run.runId))
  for (const [callId, runId] of entry.matches) {
    if (!runIds.has(runId)) {
      entry.matches.delete(callId)
    }
  }
  const taken = (): { calls: Set<string>; runs: Set<string> } => ({
    calls: new Set(entry.matches.keys()),
    runs: new Set(entry.matches.values())
  })
  const running = candidates(entry, true)
  for (const run of entry.runs) {
    if (run.state !== 'running' || run.codeTruncated || taken().runs.has(run.runId)) {
      continue
    }
    const callId = matchRunToCall(
      { runningToolCalls: running, matchedCallIds: taken().calls },
      run.code
    )
    if (callId !== null) {
      entry.matches.set(callId, run.runId)
    }
  }
  const settled = candidates(entry, false).toReversed()
  for (const run of entry.runs.toReversed()) {
    if (run.codeTruncated || taken().runs.has(run.runId)) {
      continue
    }
    const callId = matchRunToCall(
      { runningToolCalls: settled, matchedCallIds: taken().calls },
      run.code
    )
    if (callId !== null) {
      entry.matches.set(callId, run.runId)
    }
  }
}

function changed(entry: Entry): void {
  rematch(entry)
  entry.version += 1
  for (const listener of entry.listeners) {
    listener()
  }
}

function start(entry: Entry): void {
  let closed = false
  const handle = subscribeRuntimeRpc(
    entry.target,
    CODEMODE_RUNS_SUBSCRIBE_METHOD,
    {
      sessionId: entry.sessionId
    },
    {
      onEvent: (result) => {
        if (closed || typeof result !== 'object' || result === null || !('type' in result)) {
          return
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: frames of this method are CodemodeRunsEvent.
        entry.runs = applyCodemodeRunsEvent(entry.runs, result as CodemodeRunsEvent)
        changed(entry)
      },
      // An older host has no such method: rows show the script alone.
      onError: () => {},
      onClose: () => {
        if (closed || entry.listeners.size === 0) {
          return
        }
        entry.retry = setTimeout(() => {
          entry.retry = null
          if (entry.stop === stop && entry.listeners.size > 0) {
            start(entry)
          }
        }, RESUBSCRIBE_MS)
      }
    }
  )
  const stop = (): void => {
    closed = true
    void handle.then((subscription) => subscription.unsubscribe()).catch(() => {})
  }
  entry.stop = stop
  handle.catch(() => {})
}

function releaseIfIdle(entry: Entry): void {
  if (entry.listeners.size > 0 || entry.calls.size > 0) {
    return
  }
  entry.stop?.()
  if (entry.retry) {
    clearTimeout(entry.retry)
  }
  entries.delete(codemodeRunsKey(entry.target, entry.sessionId))
}

/** One stream per session however many rows show it; the last listener closes it. */
export function retainCodemodeRuns(
  target: RuntimeClientTarget,
  sessionId: string,
  onChange: () => void
): () => void {
  const entry = entryFor(target, sessionId)
  entry.listeners.add(onChange)
  if (!entry.stop) {
    start(entry)
  }
  return () => {
    entry.listeners.delete(onChange)
    if (entry.listeners.size === 0) {
      entry.stop?.()
      entry.stop = null
    }
    releaseIfIdle(entry)
  }
}

/** A mounted run_js row offers its call for pairing with the runs the host reports. */
export function watchCodemodeCall(
  target: RuntimeClientTarget,
  sessionId: string,
  call: CodemodeWatchedCall
): () => void {
  const entry = entryFor(target, sessionId)
  entry.calls.set(call.callId, call)
  changed(entry)
  return () => {
    if (entry.calls.get(call.callId) === call) {
      entry.calls.delete(call.callId)
    }
    releaseIfIdle(entry)
  }
}

export function codemodeRunsVersion(key: string): number {
  return entries.get(key)?.version ?? 0
}

export function codemodeRunForCall(key: string, callId: string): CodemodeRunRecord | null {
  const entry = entries.get(key)
  const runId = entry?.matches.get(callId)
  return entry?.runs.find((run) => run.runId === runId) ?? null
}
