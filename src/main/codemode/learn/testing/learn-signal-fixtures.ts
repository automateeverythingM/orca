// Tests only: repeated scripts for Learn runs, and a fake writer that drafts a working function
// for each. Signal `i` calls `mcp.s<i>.find` then `mcp.s<i>.get`, recorded with their results.
import type { CodemodeLearnRun } from '../../../../shared/codemode/codemode-learn-types'
import type { CodemodeLearnRemote } from '../store/codemode-learn-ops'
import type { LearnWriterGenerate } from '../writer/codemode-learn-writer'

export const SIGNAL_NOW = 1_800_000_000_000

export function signalRun(
  i: number,
  runId: string,
  sessionId: string,
  projectRoot = '/repo'
): CodemodeLearnRun {
  return {
    runId,
    sessionId,
    projectRoot,
    startedAt: SIGNAL_NOW - 1000 + i,
    ms: 5,
    ok: true,
    code: `const a = await mcp.s${i}.find({ q: 'a' }); return mcp.s${i}.get({ id: a.id })`,
    calls: [
      { seq: 0, tool: `mcp.s${i}.find`, input: { q: 'a' }, ok: true, output: { id: 7 }, ms: 1 },
      { seq: 1, tool: `mcp.s${i}.get`, input: { id: 7 }, ok: true, output: { plan: 'pro' }, ms: 1 }
    ]
  }
}

/** Records signal `i` once in each chat; returns its shape. */
export async function recordSignal(
  store: CodemodeLearnRemote,
  i: number,
  sessions: string[] = ['s1', 's2'],
  projectRoot = '/repo'
): Promise<string> {
  let shape = ''
  for (const [n, sessionId] of sessions.entries()) {
    const recorded = await store.record(
      signalRun(i, `r${i}-${n}`, sessionId, projectRoot),
      SIGNAL_NOW
    )
    shape = recorded.shape
  }
  return shape
}

/** The signal a writer prompt is about; -1 for a chain (its data is tool names only). */
export const signalOf = (prompt: string): number =>
  Number(/mcp\.s(\d+)\.find/.exec(prompt)?.[1] ?? -1)

/** A writer reply drafting `plan<i>`, which replays signal `i`'s recorded calls. */
export function draftReply(i: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    worth: true,
    name: i < 0 ? 'chainFn' : `plan${i}`,
    description: `Finds the plan for signal ${i}`,
    params: [{ name: 'q', type: 'string' }],
    body:
      i < 0
        ? 'return await mcp.crm.find({ q })'
        : `const a = await mcp.s${i}.find({ q })\nreturn await mcp.s${i}.get({ id: a.id })`,
    sample_args: { q: 'a' },
    expect: ['pro'],
    calls_saved: 1,
    scope: 'project',
    why: 'used in two chats',
    ...overrides
  })
}

type WriterAnswer = Awaited<ReturnType<LearnWriterGenerate>>

/** A writer answering every prompt with `draftReply` for its signal, unless `reply` says otherwise. */
export function fakeGenerate(
  reply?: (i: number, prompt: string) => Promise<WriterAnswer | undefined>
): LearnWriterGenerate {
  return async (prompt) => {
    const i = signalOf(prompt)
    return (await reply?.(i, prompt)) ?? { ok: true, text: draftReply(i) }
  }
}
