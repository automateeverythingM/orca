// The Learn store's tables, caps and row shapes. No SQLite here: the store runs the SQL, in its worker.
import { createHash } from 'node:crypto'
import type {
  CodemodeLearnCall,
  CodemodeLearnRun,
  CodemodeRepeatedChain
} from '../../../../shared/codemode/codemode-learn-types'
import {
  capText,
  LEARN_CODE_CAP_BYTES,
  LearnCallBudget,
  learnCallText
} from '../codemode-learn-caps'

export { LEARN_RUN_CALL_BUDGET_BYTES } from '../codemode-learn-caps'

export const LEARN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const LEARN_MAX_RUNS = 5000
/** The whole store's stored code + input + output bytes; the oldest runs go first past it. */
export const LEARN_STORE_BUDGET_BYTES = 512 * 1024 * 1024
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

/** A list limit as an integer in [1, 500]; one that is not a number or below 1 is the default 50. */
export function clampLimit(limit: unknown): number {
  const value = Math.floor(Number(limit))
  if (Number.isNaN(value) || value < 1) {
    return DEFAULT_LIMIT
  }
  return Math.min(value, MAX_LIMIT)
}

/** Most runs `runsForShape` returns: each comes with its calls' inputs and outputs. */
export const LEARN_SHAPE_RUNS_MAX = 20

/** A `runsForShape` limit: `clampLimit`, then at most 20. */
export function clampShapeRunsLimit(limit: unknown): number {
  return Math.min(clampLimit(limit), LEARN_SHAPE_RUNS_MAX)
}

export const LEARN_SCHEMA = `
CREATE TABLE IF NOT EXISTS learn_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  code TEXT NOT NULL,
  code_truncated INTEGER NOT NULL,
  shape TEXT NOT NULL,
  call_count INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS learn_runs_shape ON learn_runs (shape, started_at);
CREATE INDEX IF NOT EXISTS learn_runs_started ON learn_runs (started_at);
CREATE TABLE IF NOT EXISTS learn_calls (
  run_id TEXT NOT NULL REFERENCES learn_runs (run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL,
  input TEXT,
  input_truncated INTEGER NOT NULL,
  output TEXT,
  output_truncated INTEGER NOT NULL,
  error TEXT,
  ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS learn_chains (
  position INTEGER PRIMARY KEY,
  signature TEXT NOT NULL,
  tools TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  occurrences INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learn_dismissed (key TEXT PRIMARY KEY, dismissed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS learn_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`

/** Deletes the oldest runs past the newest `?`. */
export const DELETE_PAST_RUN_COUNT = `DELETE FROM learn_runs WHERE run_id IN (SELECT run_id
  FROM learn_runs ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?)`

/** Deletes the oldest runs whose stored bytes, summed from the newest, pass `?`. */
export const DELETE_PAST_BYTE_BUDGET = `DELETE FROM learn_runs WHERE run_id IN (SELECT run_id FROM
  (SELECT run_id, SUM(stored_bytes) OVER (ORDER BY started_at DESC, rowid DESC) AS total
     FROM learn_runs) WHERE total > ?)`

type Column = string | number | null

const byteLength = (text: string | null): number => (text === null ? 0 : Buffer.byteLength(text))

/** A run's `learn_runs` values in schema order, its code cut to the cap. */
export function runColumns(
  run: CodemodeLearnRun,
  shape: string,
  callCount: number,
  callBytes: number
): Column[] {
  const code = capText(String(run.code), LEARN_CODE_CAP_BYTES)
  return [
    String(run.runId),
    String(run.sessionId),
    String(run.projectRoot),
    Number(run.startedAt),
    Number(run.ms),
    run.ok ? 1 : 0,
    code.text,
    code.truncated ? 1 : 0,
    shape,
    callCount,
    byteLength(code.text) + callBytes
  ]
}

/** A run's `learn_calls` values in schema order: inputs and outputs cut to their caps, and once the
 * run's call budget is spent, that call and every later one keep no input or output. A call the
 * recorder already cut keeps its cut text and marks. */
export function callColumns(
  runId: string,
  calls: readonly CodemodeLearnCall[],
  budget: number
): { rows: Column[][]; bytes: number } {
  const spending = new LearnCallBudget(budget)
  const rows = calls.map((call): Column[] => {
    const text = spending.take(learnCallText(call))
    return [
      runId,
      Number(call.seq),
      String(call.tool),
      call.ok ? 1 : 0,
      text.input,
      text.inputTruncated ? 1 : 0,
      text.output,
      text.outputTruncated ? 1 : 0,
      call.error === undefined ? null : String(call.error),
      Number(call.ms)
    ]
  })
  return { rows, bytes: spending.bytes }
}

/** Stored JSON back as its value; a cut one stays the text it was cut to. */
function storedValue(text: string, truncated: boolean): unknown {
  if (truncated) {
    return text
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

type Row = Record<string, unknown>

const num = (value: unknown): number => Number(value ?? 0)
const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

export function callOf(row: Row): CodemodeLearnCall {
  const inputCut = num(row.input_truncated) === 1
  const outputCut = num(row.output_truncated) === 1
  const call: CodemodeLearnCall = {
    seq: num(row.seq),
    tool: str(row.tool),
    input:
      row.input === null || row.input === undefined ? null : storedValue(str(row.input), inputCut),
    ok: num(row.ok) === 1,
    ms: num(row.ms)
  }
  if (row.output !== null && row.output !== undefined) {
    call.output = storedValue(str(row.output), outputCut)
  }
  if (row.error !== null && row.error !== undefined) {
    call.error = str(row.error)
  }
  if (inputCut) {
    call.inputTruncated = true
  }
  if (outputCut) {
    call.outputTruncated = true
  }
  return call
}

export function runOf(row: Row, calls: CodemodeLearnCall[]): CodemodeLearnRun {
  const run: CodemodeLearnRun = {
    runId: str(row.run_id),
    sessionId: str(row.session_id),
    projectRoot: str(row.project_root),
    startedAt: num(row.started_at),
    ms: num(row.ms),
    ok: num(row.ok) === 1,
    code: str(row.code),
    calls
  }
  if (num(row.code_truncated) === 1) {
    run.codeTruncated = true
  }
  return run
}

/** Longest chain signature used as its own key; a longer one is keyed by its hash. */
const CHAIN_KEY_MAX_BYTES = 1024

/** A chain's stored, listed and dismiss key: its signature while that is at most 1 KiB, else `h:` and
 *  the signature's SHA-256 hex. A signature always holds a separator, so it is never a hashed key;
 *  a key is its own key. */
export function learnChainKey(signature: string): string {
  return Buffer.byteLength(signature) <= CHAIN_KEY_MAX_BYTES
    ? signature
    : `h:${createHash('sha256').update(signature).digest('hex')}`
}

export function chainOf(row: Row): CodemodeRepeatedChain {
  let tools: string[] = []
  try {
    const parsed: unknown = JSON.parse(str(row.tools))
    tools = Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    tools = []
  }
  return {
    kind: 'chain',
    // Why: chains saved before keys were hashed may hold a longer signature.
    signature: learnChainKey(str(row.signature)),
    tools,
    sessions: num(row.sessions),
    occurrences: num(row.occurrences),
    lastSeen: num(row.last_seen)
  }
}
