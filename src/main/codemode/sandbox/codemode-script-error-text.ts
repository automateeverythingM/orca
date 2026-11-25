export const SCRIPT_FILE = 'run_js'
const SCRIPT_FRAME = /run_js:(\d+)(?::(\d+))?/
// Saved functions are evaluated under their display path, line for line with the file.
const LIB_FRAME = /\blib\/[A-Za-z_$][\w$]*\.js:\d+/
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

// Agent code starts on line 2 of wrapScript's output, so stack lines shift by one; lib frames stay.
function scriptFrames(stack: unknown, codeLines: number): string[] {
  if (typeof stack !== 'string') {
    return []
  }
  return stack.split('\n').flatMap((frame) => {
    if (LIB_FRAME.test(frame)) {
      return [frame]
    }
    const match = SCRIPT_FRAME.exec(frame)
    const line = match ? Number(match[1]) - 1 : 0
    if (!match || line < 1 || line > codeLines) {
      return []
    }
    return [frame.replace(match[0], match[2] ? `line ${line}:${match[2]}` : `line ${line}`)]
  })
}

// Shape produced by the prelude's thrown-value reader.
export type ThrownFields =
  | { text: string }
  | { name: string | null; message: string | null; stack: string | null }

export function thrownValueText(thrown: ThrownFields, code: string, memoryBytes: number): string {
  if ('text' in thrown) {
    return thrown.text
  }
  const { name, message, stack } = thrown
  if (message === null) {
    return name === null ? 'uncaught non-Error value' : `uncaught ${name}`
  }
  if (name === 'InternalError' && message === 'out of memory') {
    return `memory limit ${byteSizeText(memoryBytes)}`
  }
  const header = name === null || name === 'Error' ? message : `${name}: ${message}`
  return [header, ...scriptFrames(stack, code.split('\n').length)].join('\n')
}
