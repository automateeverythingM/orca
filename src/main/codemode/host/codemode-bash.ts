import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { terminateWindowsProcessTree } from '../../pty/process-retirement/windows-process-tree-kill'
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
// Bounds memory while the child is still running; trimOutput then cuts to the agent limit.
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/** POSIX uses /bin/sh for predictable behaviour; Windows uses cmd.exe with verbatim arguments. */
function shellProcess(cmd: string): { program: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32') {
    const program = process.env.ComSpec || windowsSystem32Binary('cmd.exe')
    return { program, args: ['/d', '/s', '/c', `"${cmd}"`], verbatim: true }
  }
  return { program: '/bin/sh', args: ['-c', cmd], verbatim: false }
}

function killGroup(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    return
  }
  if (process.platform === 'win32') {
    void terminateWindowsProcessTree(pid, { site: 'codemode-bash' }).then((ok) => {
      if (!ok) {
        child.kill()
      }
    })
    return
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch {
      /* group already gone */
    }
  }
  signalGroup('SIGTERM')
  setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref()
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
    note = ''
  ): { exit_code: number; output: string } => {
    const trimmed = trimOutput(text, opts.limits.outputBytes)
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
    const chunks: Buffer[] = []
    let captured = 0
    let note = ''
    let forcedCode: number | null = null
    let settled = false
    let closeWait: ReturnType<typeof setTimeout> | undefined

    const collect = (chunk: Buffer): void => {
      if (captured < MAX_CAPTURE_BYTES) {
        chunks.push(chunk)
        captured += chunk.length
      }
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
      resolve(finish(forcedCode ?? code, Buffer.concat(chunks).toString('utf8'), note))
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
      chunks.push(Buffer.from(error.message))
      settle(127)
    })
    child.on('close', (code, signal) => settle(code ?? (signal ? 128 : 1)))
  })
}
