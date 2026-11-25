// The Learn store's calls the Learn DB worker answers, and their async shape on the main side. Each
// call is one request; each write is one statement or transaction in the worker.
import type { CodemodeLearnStore } from './codemode-learn-store'

export const CODEMODE_LEARN_OPS = [
  'record',
  'repeatedScripts',
  'runsForShape',
  'saveChains',
  'chains',
  'dismiss',
  'dismissed',
  'clear',
  'compact',
  'stats'
] as const satisfies readonly (keyof CodemodeLearnStore)[]

export type CodemodeLearnOp = (typeof CODEMODE_LEARN_OPS)[number]

/** The store as the main side reaches it: every call answered by the worker. */
export type CodemodeLearnRemote = {
  [K in CodemodeLearnOp]: CodemodeLearnStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never
}

export function isCodemodeLearnOp(op: string): op is CodemodeLearnOp {
  return CODEMODE_LEARN_OPS.some((entry) => entry === op)
}

/** Runs one call the client sent; `CodemodeLearnRemote` gives each op its own method's arguments. */
export function callLearnOp(
  store: CodemodeLearnStore,
  op: CodemodeLearnOp,
  args: readonly unknown[]
): unknown {
  const method: (...args: never[]) => unknown = store[op]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the args crossed the worker boundary from a CodemodeLearnRemote call of this same op.
  return method.apply(store, args as never[])
}

/** A store opened in this process (tests, off Electron main), behind the same async shape. */
export function inProcessLearnStore(store: () => CodemodeLearnStore): CodemodeLearnRemote {
  const remote = Object.fromEntries(
    CODEMODE_LEARN_OPS.map((op) => [
      op,
      async (...args: unknown[]) => callLearnOp(store(), op, args)
    ])
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each op forwards its own arguments to the store method of that name.
  return remote as unknown as CodemodeLearnRemote
}
