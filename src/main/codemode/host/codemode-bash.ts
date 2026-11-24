import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import type { CodemodeLimits } from '../codemode-limits'
import { trimOutput } from '../sandbox/codemode-output-trim'

export type BashOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs?: number
  signal: AbortSignal
  limits: CodemodeLimits
}

const KILL_GRACE_MS = 2_000
const CLOSE_WAIT_MS = 1_000

/** POSIX uses /bin/sh for predictable behaviour; Windows uses cmd.exe with verbatim arguments. */
function shellProcess(cmd: string): { program: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32') {
    const program = process.env.ComSpec || windowsSystem32Binary('cmd.exe')
    return { program, args: ['/d', '/s', '/c', `"${cmd}"`], verbatim: true }
  }
  return { program: '/bin/sh', args: ['-c', cmd], verbatim: false }
}

function killGroup(child: ChildProcess): void {
  void signalProcessTree(child, 'SIGTERM').catch(() => false)
  setTimeout(() => {
    void forceTerminateProcessTree(child).catch(() => false)
  }, KILL_GRACE_MS).unref()
}

/** Keeps the first and last `limit` bytes plus a count of what was dropped between them. */
class HeadTailCapture {
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private total = 0
  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length
    let rest = chunk
    if (this.head.length < this.limit) {
      const take = this.limit - this.head.length
      this.head = Buffer.concat([this.head, rest.subarray(0, take)])
      rest = rest.subarray(take)
    }
    if (rest.length > 0) {
      const joined = Buffer.concat([this.tail, rest])
      this.tail = joined.length > this.limit ? joined.subarray(joined.length - this.limit) : joined
    }
  }

  result(): { text: string; dropped: number } {
    const dropped = this.total - this.head.length - this.tail.length
    return { text: Buffer.concat([this.head, this.tail]).toString('utf8'), dropped }
  }
}

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`
}

/** Never throws: failures to start surface as a non-zero exit_code with the error as output. */
export function runBash(
  cmd: string,
  opts: BashOptions
): Promise<{ exit_code: number; output: string }> {
  const requested = opts.timeoutMs ?? opts.limits.bashDefaultMs
  const timeoutMs = Math.min(Math.max(requested, 1), opts.limits.bashMaxMs)
  const finish = (
    exit_code: number,
    text: string,
    note = '',
    dropped = 0
  ): { exit_code: number; output: string } => {
    const trimmed = trimOutput(text, opts.limits.outputBytes, dropped)
    return {
      exit_code,
      output: note ? `${trimmed}${trimmed.endsWith('\n') || !trimmed ? '' : '\n'}${note}` : trimmed
    }
  }
  if (opts.signal.aborted) {
    return Promise.resolve(finish(130, '', '[interrupted]'))
  }
  return new Promise((resolve) => {
    const shell = shellProcess(cmd)
    let child: ChildProcess
    try {
      child = spawnProcess({
        program: shell.program,
        args: shell.args,
        cwd: opts.cwd,
        env: opts.env,
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: shell.verbatim,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve(finish(127, error instanceof Error ? error.message : String(error)))
      return
    }
    const capture = new HeadTailCapture(opts.limits.outputBytes)
    let note = ''
    let forcedCode: number | null = null
    let settled = false
    let closeWait: ReturnType<typeof setTimeout> | undefined

    const collect = (chunk: Buffer): void => {
      capture.push(chunk)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const settle = (code: number): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(closeWait)
      opts.signal.removeEventListener('abort', onAbort)
      const { text, dropped } = capture.result()
      resolve(finish(forcedCode ?? code, text, note, dropped))
    }
    const stop = (code: number, message: string): void => {
      if (forcedCode !== null) {
        return
      }
      forcedCode = code
      note = message
      killGroup(child)
      // Pipes held by escaped descendants must not keep the call open forever.
      closeWait = setTimeout(() => settle(code), KILL_GRACE_MS + CLOSE_WAIT_MS)
    }
    const timer = setTimeout(
      () => stop(124, `[timed out after ${formatSeconds(timeoutMs)}]`),
      timeoutMs
    )
    const onAbort = (): void => stop(130, '[interrupted]')
    opts.signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      capture.push(Buffer.from(error.message))
      settle(127)
    })
    child.on('close', (code, signal) => settle(code ?? (signal ? 128 : 1)))
  })
}
