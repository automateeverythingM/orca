import type { ScriptResult } from './codemode-script-runner'

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80

/** `extraCut` counts bytes the caller already dropped between head and tail of `text`. */
export function trimOutput(text: string, maxBytes: number, extraCut = 0): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes && extraCut === 0) {
    return text
  }
  let headEnd = Math.floor(maxBytes / 2)
  while (headEnd > 0 && isContinuationByte(buffer[headEnd])) {
    headEnd--
  }
  let tailStart = buffer.length - (maxBytes - Math.floor(maxBytes / 2))
  while (tailStart < buffer.length && isContinuationByte(buffer[tailStart])) {
    tailStart++
  }
  const cut = Math.max(0, tailStart - headEnd) + extraCut
  const head = buffer.subarray(0, headEnd).toString('utf8')
  const tail = buffer.subarray(tailStart).toString('utf8')
  return `${head}\n…[${cut} bytes cut]…\n${tail}`
}

function valueText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** One inner call as the text result lists it. */
export type InnerCallLine = { tool: string; ok: boolean; ms: number }

// The calls list takes at most this share of the budget; the script's own output keeps the rest.
const CALLS_SHARE = 4

/** Printed lines and the value, then the inner calls, if any, for a chat that can't show the run's rows. */
export function formatScriptResult(
  result: ScriptResult,
  maxBytes: number,
  calls: readonly InnerCallLine[] = []
): { text: string; isError: boolean } {
  const last = result.ok ? `=> ${valueText(result.value)}` : `Error: ${result.error}`
  const body = [...result.printed, last].join('\n')
  if (calls.length === 0) {
    return { text: trimOutput(body, maxBytes), isError: !result.ok }
  }
  const lines = calls.map(({ tool, ok, ms }) => `${tool} ${ok ? '✓' : '✗'} ${ms}ms`)
  const list = trimOutput(['Inner calls:', ...lines].join('\n'), Math.floor(maxBytes / CALLS_SHARE))
  const room = Math.max(0, maxBytes - Buffer.byteLength(list, 'utf8') - 1)
  return { text: `${trimOutput(body, room)}\n${list}`, isError: !result.ok }
}
