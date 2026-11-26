// A sandbox host that answers only from what Learn recorded: nothing real is ever called. A Learn
// proposal is tested against it, so a call the source runs never made fails the test.
import type {
  CodemodeLearnCall,
  CodemodeLearnRun
} from '../../../../shared/codemode/codemode-learn-types'
import { hostCallLabel } from '../../host/codemode-host-dispatch'
import type { HostReply, ScriptHost } from '../../sandbox/codemode-host-tools'

export const LIB_NOT_REPLAYED = 'lib calls are not replayed'
export const unrecordedCallText = (label: string): string => `unrecorded call: ${label}`

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys)
  }
  if (value !== null && typeof value === 'object') {
    // Why: fromEntries defines own properties, so a `__proto__` key stays data.
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortedKeys(item)])
    )
  }
  return value
}

/** JSON with object keys sorted at every depth; a missing value is `null`, as Learn stores it. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedKeys(value ?? null)) ?? 'null'
}

const callKey = (tool: string, input: unknown): string => `${tool}\u0000${canonicalJson(input)}`

export type ReplayHost = {
  host: ScriptHost
  /** Labels of calls no usable recording answered, in call order. */
  unrecorded: string[]
  /** Why each refused call fails the test, in call order. */
  failures: string[]
  /** One line per call: `✓ label`, or `✗ <why>: label`. */
  lines: string[]
}

/** The first usable recording of each (label, input); a cut input or output is never used. */
function recordingIndex(runs: CodemodeLearnRun[]): Map<string, CodemodeLearnCall> {
  const index = new Map<string, CodemodeLearnCall>()
  for (const run of runs) {
    for (const call of run.calls) {
      if (call.inputTruncated || call.outputTruncated) {
        continue
      }
      const key = callKey(call.tool, call.input)
      if (!index.has(key)) {
        index.set(key, call)
      }
    }
  }
  return index
}

function replyOf(call: CodemodeLearnCall): HostReply {
  return call.ok
    ? { ok: true, value: call.output }
    : { ok: false, error: call.error ?? 'call failed' }
}

export function replayHost(runs: CodemodeLearnRun[]): ReplayHost {
  const index = recordingIndex(runs)
  const unrecorded: string[] = []
  const failures: string[] = []
  const lines: string[] = []
  const host: ScriptHost = async (call) => {
    const label = hostCallLabel(call)
    if (call.tool.startsWith('lib.')) {
      failures.push(LIB_NOT_REPLAYED)
      lines.push(`✗ ${LIB_NOT_REPLAYED}: ${label.tool}`)
      return { ok: false, error: LIB_NOT_REPLAYED }
    }
    const match = index.get(callKey(label.tool, label.input))
    if (!match) {
      const error = unrecordedCallText(label.tool)
      unrecorded.push(label.tool)
      failures.push(error)
      lines.push(`✗ ${error}`)
      return { ok: false, error }
    }
    lines.push(`✓ ${label.tool}`)
    return replyOf(match)
  }
  return { host, unrecorded, failures, lines }
}
