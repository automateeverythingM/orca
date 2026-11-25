import {
  CODEMODE_LIB_NAME,
  CODEMODE_LIB_RESERVED,
  type CodemodeLibFunction,
  type CodemodeLibMeta,
  type CodemodeLibScope
} from '../../../shared/codemode/codemode-lib-types'
import { type GateCheck, INTERRUPTED_TEXT, READ_CHECK } from '../host/codemode-approvals'
import { clipDetail, type Fields, optionalText, text } from '../host/codemode-host-call-fields'
import type { PlannedHostCall } from '../host/codemode-host-dispatch'
import type { HostReply } from '../sandbox/codemode-host-tools'
import { libSignature } from './codemode-lib-header'
import { type CodemodeLibSaveInput, type CodemodeLibStore, libTrustKey } from './codemode-lib-store'
import { type CodemodeLibTrust, libSourceHash } from './codemode-lib-trust'
import type { CodemodeLibUsage } from './codemode-lib-usage'

export const LIB_UNAVAILABLE_TEXT = 'saved functions unavailable in this chat'

/** One chat's saved functions: its store, and the trust and usage records every chat shares. */
export type CodemodeLibAccess = {
  store: CodemodeLibStore
  trust: CodemodeLibTrust
  usage: CodemodeLibUsage
  projectRoot: string | null
}

export type LibHostTool = 'lib.list' | 'lib.describe' | 'lib.load' | 'lib.save'

export type LibHostContext = {
  /** Absent: the chat has no saved functions and every `lib.*` call fails. */
  lib?: CodemodeLibAccess
  /** The run's gate: resolves null when allowed, otherwise the refusal text. */
  check: (c: GateCheck) => Promise<string | null>
  signal: AbortSignal
  /** This run's loads by trust key, name and hash: concurrent loads share one trust card. */
  trustLoads: Map<string, Promise<HostReply>>
}

/** Signatures of the saved functions a chat can call, for its tool description. */
export async function libSignatures(store: CodemodeLibStore): Promise<string[]> {
  return (await store.list()).functions.map(libSignature)
}

function libName(tool: LibHostTool, fields: Fields): string {
  const name = text(tool, fields, 'name')
  if (!CODEMODE_LIB_NAME.test(name) || CODEMODE_LIB_RESERVED.has(name)) {
    throw new Error(`${tool}: invalid function name ${JSON.stringify(name)}`)
  }
  return name
}

function listed(fn: CodemodeLibFunction): CodemodeLibMeta & { scope: CodemodeLibScope } {
  const { name, description, params, savedBy, scope } = fn
  return { name, description, params, savedBy, scope }
}

function readOnly(execute: () => Promise<HostReply>): PlannedHostCall {
  return { ...READ_CHECK, execute }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function findFunction(lib: CodemodeLibAccess, name: string): Promise<CodemodeLibFunction> {
  const fn = await lib.store.get(name).catch((error: unknown) => {
    throw new Error(`lib/${name}.js: ${errorText(error)}`)
  })
  if (!fn) {
    throw new Error(`no saved function ${name}`)
  }
  return fn
}

/** The card's refusal, or Interrupted when the run stopped as it was allowed; null to go ahead. */
function stoppedBy(refusal: string | null, signal: AbortSignal): string | null {
  return refusal ?? (signal.aborted ? INTERRUPTED_TEXT : null)
}

/** Shows the trust card for a new or changed file. Never rejects: a shared load has many awaiters. */
async function trustedLoad(
  fn: CodemodeLibFunction,
  key: string,
  lib: CodemodeLibAccess,
  ctx: LibHostContext
): Promise<HostReply> {
  try {
    // Why: an unreadable trust file rejects here, and that fails the load closed.
    const state = await lib.trust.state(key, fn.name, fn.source)
    if (state !== 'trusted') {
      const why = state === 'unknown' ? 'new' : 'changed since you allowed it'
      const refusal = await ctx.check({
        gate: { kind: 'lib-trust' },
        allowKey: null,
        prompt: {
          title: `Run saved function ${fn.name} (${fn.scope}, ${why})`,
          detail: clipDetail(fn.source)
        }
      })
      const stopped = stoppedBy(refusal, ctx.signal)
      if (stopped !== null) {
        return { ok: false, error: `lib.${fn.name}: ${stopped}` }
      }
      await lib.trust.record(key, fn.name, fn.source)
    }
    return { ok: true, value: { name: fn.name, file: `lib/${fn.name}.js`, source: fn.source } }
  } catch (error) {
    return { ok: false, error: `lib.${fn.name}: ${errorText(error)}` }
  }
}

async function planLoad(
  name: string,
  lib: CodemodeLibAccess,
  ctx: LibHostContext
): Promise<PlannedHostCall> {
  const fn = await findFunction(lib, name)
  const key = await libTrustKey(fn.scope, lib.projectRoot)
  return readOnly(async () => {
    const loadKey = `${key}\0${name}\0${libSourceHash(fn.source)}`
    let loading = ctx.trustLoads.get(loadKey)
    if (!loading) {
      loading = trustedLoad(fn, key, lib, ctx)
      ctx.trustLoads.set(loadKey, loading)
    }
    const reply = await loading
    if (reply.ok) {
      await lib.usage.recordUse(key, name).catch(() => {})
    }
    return reply
  })
}

function saveScope(value: unknown): CodemodeLibScope {
  if (value !== 'project' && value !== 'global') {
    throw new Error("lib.save: scope must be 'project' or 'global'")
  }
  return value
}

async function planSave(
  fields: Fields,
  lib: CodemodeLibAccess,
  ctx: LibHostContext
): Promise<PlannedHostCall> {
  const name = libName('lib.save', fields)
  const scope = saveScope(fields.scope ?? 'project')
  if (scope === 'project' && lib.projectRoot === null) {
    throw new Error("no project for this chat; save with scope 'global'")
  }
  const input: CodemodeLibSaveInput = {
    name,
    source: text('lib.save', fields, 'source'),
    scope,
    description: optionalText('lib.save', fields, 'description'),
    savedBy: 'agent'
  }
  // Why: validation errors come back before any card is shown.
  const prepared = await lib.store.prepare(input)
  return readOnly(async () => {
    const replaces = prepared.exists ? ' (replaces the current one)' : ''
    const refusal = await ctx.check({
      gate: { kind: 'lib-save' },
      allowKey: null,
      prompt: {
        title: `Save function ${name} to ${scope}${replaces}`,
        detail: clipDetail(prepared.text)
      }
    })
    const stopped = stoppedBy(refusal, ctx.signal)
    if (stopped !== null) {
      return { ok: false, error: `lib.save: ${stopped}` }
    }
    const saved = await lib.store.save(input)
    await lib.trust.record(await libTrustKey(scope, lib.projectRoot), name, saved.source)
    return { ok: true, value: { name, scope, path: saved.file } }
  })
}

/** Plans `lib.list` / `lib.describe` (reads), `lib.load` (trust card when needed) and `lib.save` (save card). */
export async function planLibHostCall(
  tool: LibHostTool,
  fields: Fields,
  ctx: LibHostContext
): Promise<PlannedHostCall> {
  const { lib } = ctx
  if (!lib) {
    throw new Error(LIB_UNAVAILABLE_TEXT)
  }
  switch (tool) {
    case 'lib.list':
      return readOnly(async () => ({
        ok: true,
        value: (await lib.store.list()).functions.map(listed)
      }))
    case 'lib.describe': {
      const name = libName(tool, fields)
      return readOnly(async () => {
        const fn = await findFunction(lib, name)
        return { ok: true, value: { ...listed(fn), source: fn.source } }
      })
    }
    case 'lib.load':
      return planLoad(libName(tool, fields), lib, ctx)
    case 'lib.save':
      return planSave(fields, lib, ctx)
  }
}
