import type { ScriptResult } from './codemode-script-runner'

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80

export function trimOutput(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
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
  const cut = tailStart - headEnd
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
