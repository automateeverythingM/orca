// One Learn writer request: the prompt goes to `generate` (the person's Claude login in the app,
// a fake in tests), the reply comes back as a checked draft or a reason the person can read.
import type { CodemodeLearnDraft } from '../../../../shared/codemode/codemode-learn-types'
import { parseWriterReply } from './codemode-learn-writer-reply'

export const LEARN_WRITER_TIMEOUT_MS = 180_000
// The generation enforces the same deadline itself; this guard covers a stall before it starts.
const GUARD_GRACE_MS = 5_000

export type LearnWriterGenerate = (
  prompt: string,
  opts: { timeoutMs: number; signal?: AbortSignal }
) => Promise<{ ok: true; text: string } | { ok: false; error: string; timedOut?: true }>

export type LearnWriterResult =
  | { ok: true; draft: CodemodeLearnDraft }
  | { ok: false; reason: string; canceled?: true; notWorth?: true }

const CANCELED: LearnWriterResult = {
  ok: false,
  reason: 'The writer was canceled.',
  canceled: true
}

export async function runLearnWriter(
  prompt: string,
  deps: { generate: LearnWriterGenerate; timeoutMs?: number; signal?: AbortSignal }
): Promise<LearnWriterResult> {
  if (deps.signal?.aborted) {
    return CANCELED
  }
  const timeoutMs = deps.timeoutMs ?? LEARN_WRITER_TIMEOUT_MS
  const stop = new AbortController()
  const ended = Promise.withResolvers<LearnWriterResult>()
  const onAbort = (): void => {
    stop.abort()
    ended.resolve(CANCELED)
  }
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  // One message whichever deadline fires first: this guard or the generation's own.
  const timedOut: LearnWriterResult = {
    ok: false,
    reason: `The writer timed out after ${Math.round(timeoutMs / 1000)} s.`
  }
  const timer = setTimeout(() => {
    stop.abort()
    ended.resolve(timedOut)
  }, timeoutMs + GUARD_GRACE_MS)
  const generation = (async (): Promise<LearnWriterResult> => {
    try {
      const reply = await deps.generate(prompt, { timeoutMs, signal: stop.signal })
      if (!reply.ok) {
        return reply.timedOut
          ? timedOut
          : { ok: false, reason: `The writer could not run: ${reply.error}` }
      }
      return parseWriterReply(reply.text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `The writer could not run: ${message}` }
    }
  })()
  try {
    return await Promise.race([generation, ended.promise])
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onAbort)
  }
}
