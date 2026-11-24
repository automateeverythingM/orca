import type { CodemodeRunRecord } from '../../../../../shared/codemode/codemode-run-wire'
import { matchRunToCall } from '../../../../../shared/codemode/codemode-run-match'

export type CodemodeWatchedCall = { callId: string; code: string | null; running: boolean }

function candidates(calls: Iterable<CodemodeWatchedCall>, running: boolean) {
  return [...calls]
    .filter((call) => call.running === running && call.code !== null)
    .map((call) => ({ callId: call.callId, name: 'orca/run_js', input: { code: call.code } }))
}

/** Updates `matches` (callId → runId): live runs pair with running calls oldest first; settled runs
 *  with settled calls newest first. A pairing is kept while its run is in `runs`. */
export function pairCodemodeRuns(
  runs: readonly CodemodeRunRecord[],
  calls: Iterable<CodemodeWatchedCall>,
  matches: Map<string, string>
): void {
  const runIds = new Set(runs.map((run) => run.runId))
  for (const [callId, runId] of matches) {
    if (!runIds.has(runId)) {
      matches.delete(callId)
    }
  }
  const taken = (): { calls: Set<string>; runs: Set<string> } => ({
    calls: new Set(matches.keys()),
    runs: new Set(matches.values())
  })
  const running = candidates(calls, true)
  for (const run of runs) {
    if (run.state !== 'running' || run.codeTruncated || taken().runs.has(run.runId)) {
      continue
    }
    const callId = matchRunToCall(
      { runningToolCalls: running, matchedCallIds: taken().calls },
      run.code
    )
    if (callId !== null) {
      matches.set(callId, run.runId)
    }
  }
  const settled = candidates(calls, false).toReversed()
  for (const run of runs.toReversed()) {
    // A running run waits for its own running call; an old settled row with the same code is not it.
    if (run.state === 'running' || run.codeTruncated || taken().runs.has(run.runId)) {
      continue
    }
    const callId = matchRunToCall(
      { runningToolCalls: settled, matchedCallIds: taken().calls },
      run.code
    )
    if (callId !== null) {
      matches.set(callId, run.runId)
    }
  }
}
