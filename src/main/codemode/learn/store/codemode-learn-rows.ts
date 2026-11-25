// The Learn store's tables, caps and row shapes. No SQLite here: the store runs the SQL, in its worker.
import type {
  CodemodeLearnCall,
  CodemodeLearnRun,
  CodemodeRepeatedChain
} from '../../../../shared/codemode/codemode-learn-types'

export const LEARN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const LEARN_MAX_RUNS = 5000
const LEARN_INPUT_CAP_BYTES = 16 * 1024
const LEARN_OUTPUT_CAP_BYTES = 64 * 1024
const LEARN_CODE_CAP_BYTES = 64 * 1024

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
  call_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS learn_runs_shape ON learn_runs (shape, started_at);
CREATE INDEX IF NOT EXISTS learn_runs_started ON learn_runs (started_at);
CREATE TABLE IF NOT EXISTS learn_calls (
  run_id TEXT NOT NULL REFERENCES learn_runs (run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL,
  input TEXT NOT NULL,
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

/** Text cut to at most `cap` UTF-8 bytes, never inside a character. */
function capText(text: string, cap: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= cap) {
    return { text, truncated: false }
  }
  let end = cap
  // A continuation byte (10xxxxxx) at the cut means a character straddles it: cut before that character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--
  }
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/** A value as JSON text; one JSON cannot write (a BigInt, a cycle) is kept as its string form. */
function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return JSON.stringify(String(value))
  }
}

function cappedJson(value: unknown, cap: number): { text: string; truncated: boolean } {
  return capText(jsonOf(value), cap)
}

type Column = string | number | null

/** A run's `learn_runs` values in schema order, its code cut to the cap. */
export function runColumns(run: CodemodeLearnRun, shape: string, callCount: number): Column[] {
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
    callCount
  ]
}

/** A call's `learn_calls` values in schema order, its input and output cut to their caps. */
export function callColumns(runId: string, call: CodemodeLearnCall): Column[] {
  const input = cappedJson(call.input, LEARN_INPUT_CAP_BYTES)
  const output = call.output === undefined ? null : cappedJson(call.output, LEARN_OUTPUT_CAP_BYTES)
  return [
    runId,
    Number(call.seq),
    String(call.tool),
    call.ok ? 1 : 0,
    input.text,
    input.truncated ? 1 : 0,
    output?.text ?? null,
    output?.truncated ? 1 : 0,
    call.error === undefined ? null : String(call.error),
    Number(call.ms)
  ]
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
    input: storedValue(str(row.input), inputCut),
    ok: num(row.ok) === 1,
    ms: num(row.ms)
  }
  if (row.output !== null && row.output !== undefined) {
    call.output = storedValue(str(row.output), outputCut)
  }
  if (row.error !== null && row.error !== undefined) {
    call.error = str(row.error)
  }
  if (inputCut || outputCut) {
    call.truncated = true
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
    run.truncated = true
  }
  return run
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
    signature: str(row.signature),
    tools,
    sessions: num(row.sessions),
    occurrences: num(row.occurrences),
    lastSeen: num(row.last_seen)
  }
}
