// Tests a Learn proposal: its source runs in a fresh QuickJS sandbox whose host answers only from the
// source runs' recorded calls, so nothing real is ever called.
import type { CodemodeLearnRun } from '../../../../shared/codemode/codemode-learn-types'
import { CODEMODE_LIB_NAME } from '../../../../shared/codemode/codemode-lib-types'
import { CODEMODE_LIMITS, type CodemodeLimits } from '../../codemode-limits'
import { runScriptInWorker } from '../../sandbox/codemode-worker-run'
import { capText } from '../codemode-learn-caps'
import { replayHost } from './codemode-learn-replay-host'
import { checkSourceStructure, structureFailureText } from './codemode-learn-replay-structure'

/** The most of the returned value's JSON the log keeps. */
export const REPLAY_RESULT_LOG_BYTES = 4 * 1024

export type ReplayProposalInput = {
  source: string
  name: string
  sampleArgs: unknown
  expect: string[]
  runs: CodemodeLearnRun[]
}
export type ReplayProposalDeps = {
  workerPath?: string
  limits?: CodemodeLimits
  /** Stops the test (e.g. Learn was cleared); the result is then failed. */
  signal?: AbortSignal
}
export type ReplayResult = { status: 'passed' | 'failed'; reason?: string; log: string }

function resultText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function cutForLog(text: string): string {
  const cut = capText(text, REPLAY_RESULT_LOG_BYTES)
  return cut.truncated ? `${cut.text}…` : cut.text
}

const failed = (reason: string, log: string[]): ReplayResult => ({
  status: 'failed',
  reason,
  log: log.join('\n')
})

export async function replayProposal(
  input: ReplayProposalInput,
  deps: ReplayProposalDeps = {}
): Promise<ReplayResult> {
  const { source, name } = input
  if (!CODEMODE_LIB_NAME.test(name)) {
    return failed(`invalid function name ${JSON.stringify(name)}`, [])
  }
  const limits = deps.limits ?? CODEMODE_LIMITS
  const signal = deps.signal ?? new AbortController().signal
  const structure = await checkSourceStructure(source, name, {
    workerPath: deps.workerPath,
    limits,
    signal
  })
  if (!structure.ok) {
    const reason = structureFailureText(name)
    return failed(reason, [`✗ ${reason}`, structure.detail])
  }

  const replay = replayHost(input.runs)
  const script = `${source}\nreturn await ${name}(${JSON.stringify(input.sampleArgs ?? {})})`
  const result = await runScriptInWorker(script, replay.host, limits, signal, deps.workerPath)
  const log = [...replay.lines, ...result.printed.map((line) => `print: ${line}`)]
  if (!result.ok) {
    log.push(`error: ${result.error}`)
    // Why: a refused call usually makes the function throw; the refusal is the real reason.
    return failed(replay.failures[0] ?? result.error.split('\n')[0], log)
  }
  const json = resultText(result.value)
  log.push(`result: ${cutForLog(json)}`)
  if (replay.failures.length > 0) {
    return failed(replay.failures[0], log)
  }
  const missing = input.expect.find((text) => !json.includes(text))
  if (missing !== undefined) {
    return failed(`the result does not contain ${JSON.stringify(missing)}`, log)
  }
  return { status: 'passed', log: log.join('\n') }
}
