import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LEARN_WRITER_TIMEOUT_MS,
  runLearnWriter,
  type LearnWriterGenerate
} from './codemode-learn-writer'

const REPLY = JSON.stringify({
  worth: true,
  name: 'planForEmail',
  description: 'Plan for an email.',
  params: [{ name: 'email' }],
  body: 'return (await mcp.crm.search({ email })).plan',
  sample_args: { email: 'a@b.c' },
  expect: ['pro'],
  calls_saved: 2,
  scope: 'global',
  why: 'Repeated.'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runLearnWriter', () => {
  it('passes the prompt with a 180 s timeout and parses the draft', async () => {
    const generate = vi.fn<LearnWriterGenerate>(async () => ({ ok: true, text: REPLY }))
    const result = await runLearnWriter('PROMPT', { generate })
    expect(LEARN_WRITER_TIMEOUT_MS).toBe(180_000)
    expect(generate).toHaveBeenCalledWith('PROMPT', {
      timeoutMs: 180_000,
      signal: expect.any(AbortSignal)
    })
    expect(result).toMatchObject({ ok: true, draft: { name: 'planForEmail' } })
  })

  it('maps a generation error to a readable failure', async () => {
    const generate: LearnWriterGenerate = async () => ({
      ok: false,
      error: 'Claude CLI not found. Install it to use this.'
    })
    expect(await runLearnWriter('P', { generate })).toEqual({
      ok: false,
      reason: 'The writer could not run: Claude CLI not found. Install it to use this.'
    })
  })

  it('maps a thrown generation to a readable failure', async () => {
    const generate: LearnWriterGenerate = async () => {
      throw new Error('spawn EACCES')
    }
    expect(await runLearnWriter('P', { generate })).toEqual({
      ok: false,
      reason: 'The writer could not run: spawn EACCES'
    })
  })

  it('maps a bad reply to its parse reason', async () => {
    const generate: LearnWriterGenerate = async () => ({ ok: true, text: 'no idea' })
    expect(await runLearnWriter('P', { generate })).toEqual({
      ok: false,
      reason: 'The writer did not reply with a JSON object.'
    })
  })

  it('times out a generation that never settles and aborts it', async () => {
    vi.useFakeTimers()
    let seen: AbortSignal | undefined
    const generate: LearnWriterGenerate = (_prompt, opts) => {
      seen = opts.signal
      return new Promise(() => {})
    }
    const pending = runLearnWriter('P', { generate })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(LEARN_WRITER_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toEqual({
      ok: false,
      reason: 'The writer timed out after 180 s.'
    })
    expect(seen?.aborted).toBe(true)
  })

  it('stops when the caller aborts', async () => {
    const stop = new AbortController()
    const generate: LearnWriterGenerate = () => new Promise(() => {})
    const pending = runLearnWriter('P', { generate, signal: stop.signal })
    stop.abort()
    expect(await pending).toEqual({ ok: false, reason: 'The writer was canceled.', canceled: true })
    const never = vi.fn<LearnWriterGenerate>()
    expect(await runLearnWriter('P', { generate: never, signal: stop.signal })).toMatchObject({
      canceled: true
    })
    expect(never).not.toHaveBeenCalled()
  })
})
