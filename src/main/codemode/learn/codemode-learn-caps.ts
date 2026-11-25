// Learn's size caps, shared by the recorder (cuts each call as it settles, on main) and the store
// (cuts again in its worker, so a value that skipped the recorder is held to the same rules). Pure.
import type { CodemodeLearnCall } from '../../../shared/codemode/codemode-learn-types'

export const LEARN_INPUT_CAP_BYTES = 16 * 1024
export const LEARN_OUTPUT_CAP_BYTES = 64 * 1024
export const LEARN_CODE_CAP_BYTES = 64 * 1024
/** One run's stored call bytes (input + output JSON); later calls keep no input or output. */
export const LEARN_RUN_CALL_BUDGET_BYTES = 2 * 1024 * 1024

/** Text cut to at most `cap` UTF-8 bytes, never inside a character. */
export function capText(text: string, cap: number): { text: string; truncated: boolean } {
  // Why: each UTF-16 unit is at least one byte, so the first `cap` units hold the first `cap`
  // bytes; encoding only those keeps a 5 MB reply from becoming a 5 MB+ buffer.
  let head = text.length > cap ? text.slice(0, cap) : text
  const last = head.charCodeAt(head.length - 1)
  if (head !== text && last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1)
  }
  const bytes = Buffer.from(head, 'utf8')
  if (bytes.length <= cap) {
    return head === text ? { text, truncated: false } : { text: head, truncated: true }
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

/** A call's input and output as stored: JSON text, null when absent or dropped. */
export type LearnCallText = {
  input: string | null
  inputTruncated: boolean
  output: string | null
  outputTruncated: boolean
}

/** A field already cut (its value is the start of its JSON text) stays that text; any other is
 * written as JSON; both are held to the cap. */
function fieldText(value: unknown, cut: boolean | undefined, cap: number) {
  if (cut) {
    return value === null || value === undefined
      ? { text: null, truncated: true }
      : { ...capText(String(value), cap), truncated: true }
  }
  return capText(jsonOf(value), cap)
}

export function learnCallText(call: CodemodeLearnCall): LearnCallText {
  const input = fieldText(call.input, call.inputTruncated, LEARN_INPUT_CAP_BYTES)
  const output =
    call.output === undefined
      ? { text: null, truncated: call.outputTruncated === true }
      : fieldText(call.output, call.outputTruncated, LEARN_OUTPUT_CAP_BYTES)
  return {
    input: input.text,
    inputTruncated: input.truncated,
    output: output.text,
    outputTruncated: output.truncated
  }
}

const DROPPED: LearnCallText = {
  input: null,
  inputTruncated: true,
  output: null,
  outputTruncated: true
}

const byteLength = (text: string | null): number => (text === null ? 0 : Buffer.byteLength(text))

/** One run's call budget, spent in call order: once a call would pass it, that call and every later
 * one keep no input or output. */
export class LearnCallBudget {
  private spentBytes = 0
  private spent = false

  constructor(private readonly budget = LEARN_RUN_CALL_BUDGET_BYTES) {}

  get bytes(): number {
    return this.spentBytes
  }

  take(text: LearnCallText): LearnCallText {
    const size = byteLength(text.input) + byteLength(text.output)
    this.spent = this.spent || this.spentBytes + size > this.budget
    if (this.spent) {
      return DROPPED
    }
    this.spentBytes += size
    return text
  }
}

/** A call cut as the store would keep it, in its read-back form: a cut field is the start of its
 * JSON text, a dropped one is a null input and no output, each marked. */
export function capLearnCall(call: CodemodeLearnCall, budget: LearnCallBudget): CodemodeLearnCall {
  const text = budget.take(learnCallText(call))
  const capped: CodemodeLearnCall = {
    seq: call.seq,
    tool: call.tool,
    input: text.inputTruncated ? text.input : call.input,
    ok: call.ok,
    ms: call.ms
  }
  if (text.output !== null) {
    capped.output = text.outputTruncated ? text.output : call.output
  }
  if (call.error !== undefined) {
    capped.error = call.error
  }
  if (text.inputTruncated) {
    capped.inputTruncated = true
  }
  if (text.outputTruncated) {
    capped.outputTruncated = true
  }
  return capped
}
