import {
  CODEMODE_LIB_NAME,
  CODEMODE_LIB_RESERVED,
  type CodemodeLibFunction,
  type CodemodeLibMeta,
  type CodemodeLibScope
} from '../../../shared/codemode/codemode-lib-types'
import { fencedCode } from '../../../shared/codemode/codemode-fenced-code'
import {
  DENIED_TEXT,
  type GateCheck,
  INTERRUPTED_TEXT,
  READ_CHECK
} from '../host/codemode-approvals'
import { type Fields, optionalText, text } from '../host/codemode-host-call-fields'
import type { PlannedHostCall } from '../host/codemode-host-dispatch'
import type { HostReply } from '../sandbox/codemode-host-tools'
import { libSignature } from './codemode-lib-header'
import { type CodemodeLibSaveInput, type CodemodeLibStore, libTrustKey } from './codemode-lib-store'
import { type CodemodeLibTrust, libSourceHash } from './codemode-lib-trust'
import type { CodemodeLibUsage } from './codemode-lib-usage'

export const LIB_UNAVAILABLE_TEXT = 'saved functions unavailable in this chat'

/**
 * Trust and save cards show the whole file, so nothing can hide past what the person reads; a
 * longer file gets no card (it can be allowed in Settings).
 */
export const CODEMODE_LIB_CARD_MAX_BYTES = 16 * 1024

/**
 * A card's source as a fenced code block: the agent's client renders the card as Markdown, and
 * outside a fence an HTML comment (`<!--`, which JS also reads as a line comment) hides code.
 */
export function fencedSource(text: string): string {
  return fencedCode(text, 'js')
}

function fitsCard(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= CODEMODE_LIB_CARD_MAX_BYTES
}

/** A load that came back with the person's answer (allow, deny, stop); only these are kept for the run. */
type LoadOutcome = { reply: HostReply; answered: boolean }

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
  /** This run's loads by trust key, name and hash: in-flight loads and the person's answers. */
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
): Promise<LoadOutcome> {
  const failed = (error: string): LoadOutcome => ({
    reply: { ok: false, error: `lib.${fn.name}: ${error}` },
    answered: false
  })
  try {
    // Why: an unreadable trust file rejects here, and that fails the load closed.
    const state = await lib.trust.state(key, fn.name, fn.source)
    if (state === 'trusted') {
      return { reply: loaded(fn), answered: false }
    }
    if (!fitsCard(fn.source)) {
      const kib = Math.ceil(Buffer.byteLength(fn.source, 'utf8') / 1024)
      return failed(
        `function is too long to review in a card (${kib} KiB); allow it in Settings › Code mode › Functions`
      )
    }
    const why = state === 'unknown' ? 'new' : 'changed since you allowed it'
    const refusal = await ctx.check({
      gate: { kind: 'lib-trust' },
      allowKey: null,
      prompt: {
        title: `Run saved function ${fn.name} (${fn.scope}, ${why})`,
        detail: fencedSource(fn.source)
      }
    })
    const stopped = stoppedBy(refusal, ctx.signal)
    if (stopped !== null) {
      // Why: a mode refusal or a card the agent can't show may change within the run; the person's answer doesn't.
      const answered = stopped === DENIED_TEXT || stopped === INTERRUPTED_TEXT
      return { ...failed(stopped), answered }
    }
    await lib.trust.record(key, fn.name, fn.source)
    return { reply: loaded(fn), answered: true }
  } catch (error) {
    return failed(errorText(error))
  }
}

function loaded(fn: CodemodeLibFunction): HostReply {
  return { ok: true, value: { name: fn.name, file: `lib/${fn.name}.js`, source: fn.source } }
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
      const started: Promise<HostReply> = trustedLoad(fn, key, lib, ctx).then((outcome) => {
        // Why: in flight, loads share one card; settled, only the person's answer is kept.
        if (!outcome.answered && ctx.trustLoads.get(loadKey) === started) {
          ctx.trustLoads.delete(loadKey)
        }
        return outcome.reply
      })
      loading = started
      ctx.trustLoads.set(loadKey, started)
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
  if (!fitsCard(prepared.text)) {
    throw new Error(
      `lib.save: function is too long to review (max ${CODEMODE_LIB_CARD_MAX_BYTES / 1024} KiB)`
    )
  }
  return readOnly(async () => {
    const replaces = prepared.exists ? ' (replaces the current one)' : ''
    const refusal = await ctx.check({
      gate: { kind: 'lib-save' },
      allowKey: null,
      prompt: {
        title: `Save function ${name} to ${scope}${replaces}`,
        detail: fencedSource(prepared.text)
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
