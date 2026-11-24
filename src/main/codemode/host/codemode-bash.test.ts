import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEMODE_LIMITS } from '../codemode-limits'
import { runBash } from './codemode-bash'

const posix = process.platform !== 'win32'

describe('runBash', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'codemode-bash-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const run = (cmd: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    runBash(cmd, {
      cwd,
      env: process.env,
      signal: extra.signal ?? new AbortController().signal,
      limits: CODEMODE_LIMITS,
      timeoutMs: extra.timeoutMs
    })

  it('returns output and exit code 0', async () => {
    expect(await run('echo hi')).toEqual({ exit_code: 0, output: 'hi\n' })
  })

  it('returns the exit code and merges stderr', async () => {
    const result = await run('echo oops 1>&2; exit 3')
    expect(result.exit_code).toBe(3)
    expect(result.output).toContain('oops')
  })

  it('never throws for a missing cwd', async () => {
    const result = await runBash('echo hi', {
      cwd: join(cwd, 'missing'),
      env: process.env,
      signal: new AbortController().signal,
      limits: CODEMODE_LIMITS
    })
    expect(result.exit_code).not.toBe(0)
  })

  it('trims 100 KB of output to the limit plus a marker', async () => {
    const result = await run('head -c 100000 /dev/zero | tr "\\0" a')
    expect(result.exit_code).toBe(0)
    expect(result.output.length).toBeLessThan(CODEMODE_LIMITS.outputBytes + 300)
    expect(result.output.length).toBeLessThan(100_000)
  })

  it.skipIf(!posix)('kills the whole process group on timeout', async () => {
    const result = await run('echo $$; sleep 30 & sleep 30; wait', { timeoutMs: 300 })
    expect(result.exit_code).toBe(124)
    expect(result.output).toMatch(/\[timed out after 0\.3s\]$/)
    const pgid = Number(result.output.split('\n')[0])
    expect(pgid).toBeGreaterThan(1)
    let gone = false
    for (let i = 0; i < 40 && !gone; i++) {
      try {
        process.kill(-pgid, 0)
        await new Promise((r) => setTimeout(r, 50))
      } catch (error) {
        gone = (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }
    expect(gone).toBe(true)
  })

  it.skipIf(!posix)('kills the group and returns 130 on abort', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const result = await run('sleep 30', { signal: controller.signal })
    expect(result.exit_code).toBe(130)
    expect(result.output).toMatch(/\[interrupted\]$/)
  })

  it('returns 130 immediately when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await run('echo hi', { signal: controller.signal })
    expect(result.exit_code).toBe(130)
  })
})
