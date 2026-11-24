export const SCRIPT_FILE = 'run_js'
const SCRIPT_FRAME = /run_js:(\d+)(?::(\d+))?/
const STACK_OVERFLOW = 'InternalError: stack overflow'
const KIB = 1024
const MIB = 1024 * 1024

export function wrapScript(code: string): string {
  return `(async () => {\n${code}\n})()`
}

export function byteSizeText(bytes: number): string {
  const round = (value: number): number => Math.round(value * 100) / 100
  if (bytes >= MIB) {
    return `${round(bytes / MIB)}MB`
  }
  return bytes >= KIB ? `${round(bytes / KIB)}KB` : `${bytes} bytes`
}

export function hostErrorText(error: unknown): string {
  // Deep recursion can exhaust the host's native stack before QuickJS's own limit trips.
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return STACK_OVERFLOW
  }
  return `sandbox error: ${error instanceof Error ? error.message : String(error)}`
}

// Agent code starts on line 2 of wrapScript's output, so stack lines shift by one.
function scriptFrames(stack: unknown, codeLines: number): string[] {
  if (typeof stack !== 'string') {
    return []
  }
  return stack.split('\n').flatMap((frame) => {
    const match = SCRIPT_FRAME.exec(frame)
    const line = match ? Number(match[1]) - 1 : 0
    if (!match || line < 1 || line > codeLines) {
      return []
    }
    return [frame.replace(match[0], match[2] ? `line ${line}:${match[2]}` : `line ${line}`)]
  })
}

export function thrownValueText(thrown: unknown, code: string, memoryBytes: number): string {
  if (typeof thrown !== 'object' || thrown === null || !('message' in thrown)) {
    return typeof thrown === 'string' ? thrown : (JSON.stringify(thrown) ?? String(thrown))
  }
  const { name, message, stack } = thrown as { name?: unknown; message: unknown; stack?: unknown }
  if (name === 'InternalError' && message === 'out of memory') {
    return `memory limit ${byteSizeText(memoryBytes)}`
  }
  const header = name === undefined || name === 'Error' ? String(message) : `${name}: ${message}`
  return [header, ...scriptFrames(stack, code.split('\n').length)].join('\n')
}
