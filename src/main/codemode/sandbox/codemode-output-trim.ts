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

export function formatScriptResult(
  result: ScriptResult,
  maxBytes: number
): { text: string; isError: boolean } {
  const last = result.ok ? `=> ${valueText(result.value)}` : `Error: ${result.error}`
  return { text: trimOutput([...result.printed, last].join('\n'), maxBytes), isError: !result.ok }
}
