import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatCodeBlockRunFrame } from '../../../shared/native-chat/code-block-run/native-chat-code-block-run-types'
import {
  resolveCodeBlockRunCwd,
  resolveCodeBlockShellLaunch,
  runNativeChatCodeBlock
} from './native-chat-code-block-runner'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-code-block-run-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('resolveCodeBlockShellLaunch', () => {
  it('picks POSIX -c on macOS/Linux and avoids fish for bash blocks', () => {
    expect(
      resolveCodeBlockShellLaunch('echo hi', {
        platform: 'darwin',
        language: 'bash',
        profileShell: '/bin/zsh'
      })
    ).toEqual({ program: '/bin/zsh', args: ['-c', 'echo hi'] })

    expect(
      resolveCodeBlockShellLaunch('echo hi', {
        platform: 'linux',
        language: 'bash',
        profileShell: '/usr/bin/fish',
        posixBashExists: true
      })
    ).toEqual({ program: '/bin/bash', args: ['-c', 'echo hi'] })
  })

  it('uses Git Bash or clean PowerShell flags on Windows', () => {
    expect(
      resolveCodeBlockShellLaunch('echo hi', {
        platform: 'win32',
        language: 'bash',
        profileShell: 'C:\\Program Files\\Git\\bin\\bash.exe'
      })
    ).toEqual({ program: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c', 'echo hi'] })

    expect(
      resolveCodeBlockShellLaunch('Write-Output hi', {
        platform: 'win32',
        language: 'powershell',
        profileShell: 'pwsh.exe'
      })
    ).toEqual({
      program: 'pwsh.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output hi']
    })
  })
})

describe('resolveCodeBlockRunCwd', () => {
  it('allows subdirectories inside the workspace root and rejects traversal outside', async () => {
    const root = makeTempDir()
    const sub = join(root, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    const outside = makeTempDir()

    expect(await resolveCodeBlockRunCwd(root)).toBe(resolve(root))
    expect(await resolveCodeBlockRunCwd(root, sub)).toBe(resolve(sub))
    expect(await resolveCodeBlockRunCwd(root, 'packages/app')).toBe(resolve(sub))
    expect(await resolveCodeBlockRunCwd(root, outside)).toBe(resolve(root))
    expect(await resolveCodeBlockRunCwd(root, '../outside')).toBe(resolve(root))
  })
})

describe('runNativeChatCodeBlock', () => {
  it('streams stdout and reports succeeded with exitCode 0', async () => {
    const cwd = makeTempDir()
    const frames: NativeChatCodeBlockRunFrame[] = []

    await runNativeChatCodeBlock({
      command: '# comment\necho "hello-inline" && echo "second-line"',
      cwd,
      language: 'bash',
      env: process.env,
      emit: (frame) => frames.push(frame)
    })

    expect(frames[0]).toEqual({ type: 'started', cwd })
    const output = frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => frame.text)
      .join('')
    expect(output).toContain('hello-inline')
    expect(output).toContain('second-line')

    const exit = frames.at(-1)
    expect(exit).toMatchObject({
      type: 'exit',
      status: 'succeeded',
      exitCode: 0,
      truncated: false
    })
  })

  it('captures stderr and reports failed with the real exit code', async () => {
    const cwd = makeTempDir()
    const frames: NativeChatCodeBlockRunFrame[] = []

    await runNativeChatCodeBlock({
      command: 'echo "boom-stderr" >&2\nexit 42',
      cwd,
      language: 'bash',
      env: process.env,
      emit: (frame) => frames.push(frame)
    })

    const output = frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => frame.text)
      .join('')
    expect(output).toContain('boom-stderr')

    const exit = frames.at(-1)
    expect(exit).toMatchObject({
      type: 'exit',
      status: 'failed',
      exitCode: 42
    })
  })

  it('terminates a running command when the abort signal fires', async () => {
    const cwd = makeTempDir()
    const controller = new AbortController()
    const frames: NativeChatCodeBlockRunFrame[] = []

    const runPromise = runNativeChatCodeBlock({
      command: 'echo "started-long"\nsleep 30',
      cwd,
      language: 'bash',
      env: process.env,
      signal: controller.signal,
      emit: (frame) => {
        frames.push(frame)
        if (frame.type === 'output' && frame.text.includes('started-long')) {
          controller.abort()
        }
      }
    })

    await runPromise
    expect(controller.signal.aborted).toBe(true)
    expect(frames.some((frame) => frame.type === 'output')).toBe(true)
    expect(frames.some((frame) => frame.type === 'exit')).toBe(false)
  })
})
