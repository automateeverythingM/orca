import { access, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import {
  NATIVE_CHAT_CODE_BLOCK_MAX_OUTPUT_CHARS,
  type NativeChatCodeBlockRunFrame
} from '../../../shared/native-chat/code-block-run/native-chat-code-block-run-types'
import { sanitizeCodeBlockRunChunk } from '../../../shared/native-chat/code-block-run/native-chat-code-block-output'
import { resolveWindowsShellStartupFamily } from '../../../shared/shell/launch/windows-terminal-shell'
import { promptGuardShellEnv } from '../../git/command-runner/git-environment/git-process-env'
import { dropIncoherentCondaActivationEnv } from '../../pty/shell-startup/conda-activation-env'
import { resolveProfileLoadingShell } from '../../startup/shell-environment/hydrate-shell-path'
import { resolveLoginShellEnvironment } from '../../startup/shell-environment/login-shell-environment'

const OUTPUT_FLUSH_INTERVAL_MS = 50
const MAX_PENDING_OUTPUT_CHARS = 32 * 1024
const SIGTERM_GRACE_MS = 2_000

const POSIX_ONLY_LANGUAGES = new Set([
  'bash',
  'sh',
  'shell',
  'shellscript',
  'zsh',
  'console',
  'shellsession'
])

export type CodeBlockShellLaunch = {
  program: string
  args: string[]
}

/** Pick an argv-safe shell invocation without `shell: true` or Windows EDR-sensitive flags. */
export function resolveCodeBlockShellLaunch(
  command: string,
  options: {
    platform?: NodeJS.Platform
    language?: string
    profileShell?: string | null
    comSpec?: string
    posixBashExists?: boolean
  } = {}
): CodeBlockShellLaunch {
  const platform = options.platform ?? process.platform
  const profileShell =
    options.profileShell !== undefined ? options.profileShell : resolveProfileLoadingShell()
  const language = options.language?.trim().toLowerCase()

  if (platform === 'win32') {
    const family = profileShell ? resolveWindowsShellStartupFamily(profileShell) : null
    if (profileShell && family === 'posix') {
      return { program: profileShell, args: ['-c', command] }
    }
    const powerShell = profileShell && family === 'powershell' ? profileShell : 'powershell.exe'
    return {
      program: powerShell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    }
  }

  const shellName = profileShell ? basename(profileShell).toLowerCase() : ''
  const needsPosixShell = Boolean(language && POSIX_ONLY_LANGUAGES.has(language))
  const nonPosixUserShell = shellName === 'fish' || shellName === 'nu' || shellName === 'xonsh'
  if (needsPosixShell && nonPosixUserShell) {
    const hasBinBash = options.posixBashExists ?? true
    return { program: hasBinBash ? '/bin/bash' : '/bin/sh', args: ['-c', command] }
  }
  const program = profileShell?.trim() || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  return { program, args: ['-c', command] }
}

/** Keep requested subfolder `cwd` inside the resolved workspace root; fall back to the root otherwise. */
export async function resolveCodeBlockRunCwd(
  workspaceRoot: string,
  requestedCwd?: string
): Promise<string> {
  const normalizedRoot = resolve(workspaceRoot)
  if (!requestedCwd?.trim()) {
    return normalizedRoot
  }
  const candidate = isAbsolute(requestedCwd)
    ? resolve(requestedCwd)
    : resolve(normalizedRoot, requestedCwd)
  const rel = relative(normalizedRoot, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return normalizedRoot
  }
  try {
    const info = await stat(candidate)
    return info.isDirectory() ? candidate : normalizedRoot
  } catch {
    return normalizedRoot
  }
}

export type RunNativeChatCodeBlockArgs = {
  command: string
  cwd: string
  language?: string
  signal?: AbortSignal
  emit: (frame: NativeChatCodeBlockRunFrame) => void
  env?: NodeJS.ProcessEnv
  maxOutputChars?: number
}

/** Run a shell code block in `cwd`, streaming sanitized output and exiting with an explicit status frame. */
export async function runNativeChatCodeBlock(args: RunNativeChatCodeBlockArgs): Promise<void> {
  const { command, cwd, language, signal, emit } = args
  const maxOutputChars = args.maxOutputChars ?? NATIVE_CHAT_CODE_BLOCK_MAX_OUTPUT_CHARS
  if (signal?.aborted) {
    return
  }

  const startedAt = Date.now()
  const baseEnv: NodeJS.ProcessEnv = args.env
    ? { ...args.env }
    : { ...(await resolveLoginShellEnvironment()) }
  if (signal?.aborted) {
    return
  }
  dropIncoherentCondaActivationEnv(baseEnv)
  const env = promptGuardShellEnv(baseEnv)
  const posixBashExists =
    process.platform === 'win32'
      ? false
      : await access('/bin/bash').then(
          () => true,
          () => false
        )
  const launch = resolveCodeBlockShellLaunch(command, { language, posixBashExists })

  emit({ type: 'started', cwd })

  await new Promise<void>((resolvePromise) => {
    let settled = false
    let emittedChars = 0
    let truncated = false
    let pendingStream: 'stdout' | 'stderr' | null = null
    let pendingText = ''
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let killEscalationTimer: ReturnType<typeof setTimeout> | null = null

    let child: ChildProcess
    try {
      child = spawnProcess({
        program: launch.program,
        args: launch.args,
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX process groups let Stop kill child build trees; Windows detached creates a new console.
        ...(process.platform === 'win32' ? {} : { detached: true })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({
        type: 'exit',
        status: 'failed',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        truncated: false,
        error: message
      })
      resolvePromise()
      return
    }

    const flush = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!pendingText || !pendingStream) {
        return
      }
      const stream = pendingStream
      const text = pendingText
      pendingStream = null
      pendingText = ''
      if (!signal?.aborted) {
        emit({ type: 'output', stream, text })
      }
    }

    const queueOutput = (stream: 'stdout' | 'stderr', raw: string): void => {
      if (settled || signal?.aborted) {
        return
      }
      const text = sanitizeCodeBlockRunChunk(raw)
      if (!text) {
        return
      }
      emittedChars += text.length
      if (emittedChars > maxOutputChars) {
        truncated = true
      }
      if (pendingStream && pendingStream !== stream) {
        flush()
      }
      pendingStream = stream
      pendingText += text
      // Cap each timed batch to its latest tail so runaway stdout cannot flood IPC while errors stay visible.
      if (pendingText.length > MAX_PENDING_OUTPUT_CHARS) {
        pendingText = pendingText.slice(pendingText.length - MAX_PENDING_OUTPUT_CHARS)
        truncated = true
      }
      if (!flushTimer) {
        flushTimer = setTimeout(flush, OUTPUT_FLUSH_INTERVAL_MS)
      }
    }

    const cleanup = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer)
        killEscalationTimer = null
      }
      signal?.removeEventListener('abort', onAbort)
    }

    const finish = (frame?: NativeChatCodeBlockRunFrame): void => {
      if (settled) {
        return
      }
      settled = true
      flush()
      cleanup()
      if (frame && !signal?.aborted) {
        emit(frame)
      }
      resolvePromise()
    }

    const onAbort = (): void => {
      void signalProcessTree(child, 'SIGTERM')
      killEscalationTimer = setTimeout(() => {
        void forceTerminateProcessTree(child)
      }, SIGTERM_GRACE_MS)
      killEscalationTimer.unref?.()
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer | string) => {
      queueOutput('stdout', typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      queueOutput('stderr', typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})

    child.once('error', (error) => {
      finish({
        type: 'exit',
        status: signal?.aborted ? 'cancelled' : 'failed',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        truncated,
        error: error.message
      })
    })

    child.once('close', (code, exitSignal) => {
      const cancelled = Boolean(signal?.aborted)
      finish({
        type: 'exit',
        status: cancelled ? 'cancelled' : code === 0 ? 'succeeded' : 'failed',
        exitCode: typeof code === 'number' ? code : null,
        signal: exitSignal ?? null,
        durationMs: Date.now() - startedAt,
        truncated
      })
    })

    if (signal?.aborted) {
      onAbort()
    }
  })
}
