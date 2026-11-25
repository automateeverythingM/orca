import type {
  CodemodeLibEntryView,
  CodemodeLibFunction,
  CodemodeLibListView,
  CodemodeLibScope,
  CodemodeLibVersion
} from '../../../../../shared/codemode/codemode-lib-types'
import {
  CodemodeLibList,
  CodemodeLibMove,
  CodemodeLibRead,
  CodemodeLibTarget,
  CodemodeLibTrust
} from '../../../../../shared/rpc-contract/codemode/codemode-lib-params'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { installedCodemodeService } from '../../../../codemode/codemode-process-service'
import { libAccessFor, type CodemodeLibRecords } from '../../../../codemode/lib/codemode-lib-access'
import type { CodemodeLibAccess } from '../../../../codemode/lib/codemode-lib-host-plan'
import { CodemodeLibStore, libTrustKey } from '../../../../codemode/lib/codemode-lib-store'
import { libSourceHash } from '../../../../codemode/lib/codemode-lib-trust'
import { defineMethod, type RpcContext } from '../../core'

export type CodemodeLibMethodDeps = {
  /** Code mode runs only in the desktop app (its worker and WASM ship only there). */
  desktop: () => boolean
  /** The trust and usage records the chats share; one instance each, so writes queue together. */
  records: (ctx: RpcContext) => Promise<CodemodeLibRecords>
  /** Refuses a root that is not one of Orca's worktrees, before any file under it is read. */
  projectAccess: (ctx: RpcContext, projectRoot: string) => Promise<void>
}

type WorktreeList = () => Promise<{ worktrees: readonly { path: string; hostId?: string }[] }>

/**
 * A project root must be exactly the path of a worktree Orca manages on this computer; `..`, a
 * parent, or an SSH or paired-runtime worktree's path (another machine's file system) is not.
 */
export async function requireKnownProject(list: WorktreeList, projectRoot: string): Promise<void> {
  const { worktrees } = await list()
  const local = (hostId: string | undefined): boolean =>
    hostId === undefined || hostId === LOCAL_EXECUTION_HOST_ID
  if (!worktrees.some((worktree) => worktree.path === projectRoot && local(worktree.hostId))) {
    throw new Error('unknown project')
  }
}

async function runtimeRecords(ctx: RpcContext): Promise<CodemodeLibRecords> {
  // Why: the host's install creates the service; Settings must share its records, never build new ones.
  await ctx.runtime.ensureStructuredAgentSessionHost()
  const service = installedCodemodeService()
  if (!service) {
    throw new Error('saved functions unavailable')
  }
  return service.libRecords()
}

const RUNTIME_DEPS: CodemodeLibMethodDeps = {
  desktop: () => process.versions.electron !== undefined,
  records: runtimeRecords,
  projectAccess: (ctx, projectRoot) =>
    requireKnownProject(
      () => ctx.runtime.listManagedWorktrees(undefined, Number.MAX_SAFE_INTEGER),
      projectRoot
    )
}

type Opened = CodemodeLibAccess & { keys: Map<CodemodeLibScope, Promise<string>> }

async function viewOf(
  lib: Opened,
  fn: CodemodeLibFunction,
  shadowed: boolean
): Promise<CodemodeLibEntryView> {
  const key = await keyFor(lib, fn.scope)
  const [state, usage] = await Promise.all([
    lib.trust.state(key, fn.name, fn.source),
    lib.usage.read(key, fn.name)
  ])
  return {
    name: fn.name,
    description: fn.description,
    params: fn.params,
    savedBy: fn.savedBy,
    scope: fn.scope,
    uses: usage.uses,
    ...(usage.lastUsedAt !== undefined ? { lastUsedAt: usage.lastUsedAt } : {}),
    trusted: state === 'trusted',
    shadowed,
    sha256: libSourceHash(fn.source)
  }
}

function keyFor(lib: Opened, scope: CodemodeLibScope): Promise<string> {
  let key = lib.keys.get(scope)
  if (!key) {
    key = libTrustKey(scope, lib.projectRoot)
    lib.keys.set(scope, key)
  }
  return key
}

async function requireFunction(
  lib: Opened,
  name: string,
  scope: CodemodeLibScope
): Promise<CodemodeLibFunction> {
  const fn = await lib.store.read(name, scope)
  if (!fn) {
    throw new Error(`no function ${name} in ${scope} scope`)
  }
  return fn
}

/** `codemode.lib.*`: Settings › Functions. Each call is the person's own action in Settings. */
export function codemodeLibMethods(deps: CodemodeLibMethodDeps) {
  const open = async (ctx: RpcContext, projectRoot: string | undefined): Promise<Opened> => {
    if (!deps.desktop()) {
      throw new Error('code mode is only available in the desktop app')
    }
    if (projectRoot !== undefined) {
      await deps.projectAccess(ctx, projectRoot)
    }
    const records = await deps.records(ctx)
    const access: CodemodeLibAccess =
      projectRoot === undefined
        ? {
            store: new CodemodeLibStore({ projectRoot: null, homeDir: records.homeDir }),
            trust: records.trust,
            usage: records.usage,
            projectRoot: null
          }
        : await libAccessFor(projectRoot, records)
    return { ...access, keys: new Map() }
  }

  return [
    defineMethod({
      name: 'codemode.lib.list',
      permission: 'workspace',
      params: CodemodeLibList,
      handler: async (params, ctx): Promise<CodemodeLibListView> => {
        const lib = await open(ctx, params.projectRoot)
        const project = await lib.store.listScope('project')
        const global = await lib.store.listScope('global')
        const hidden = new Set(project.functions.map((fn) => fn.name))
        const functions = await Promise.all([
          ...project.functions.map((fn) => viewOf(lib, fn, false)),
          ...global.functions.map((fn) => viewOf(lib, fn, hidden.has(fn.name)))
        ])
        // Same name: the project one first, the global it hides right after.
        functions.sort((a, b) => a.name.localeCompare(b.name) || (a.scope === 'project' ? -1 : 1))
        return { functions, problems: [...project.problems, ...global.problems] }
      }
    }),
    defineMethod({
      name: 'codemode.lib.read',
      permission: 'workspace',
      params: CodemodeLibRead,
      handler: async (params, ctx): Promise<{ source: string; sha256: string }> => {
        const lib = await open(ctx, params.projectRoot)
        const source =
          params.version !== undefined
            ? await lib.store.readVersion(params.name, params.scope, params.version)
            : (await requireFunction(lib, params.name, params.scope)).source
        return { source, sha256: libSourceHash(source) }
      }
    }),
    defineMethod({
      name: 'codemode.lib.history',
      permission: 'workspace',
      params: CodemodeLibTarget,
      handler: async (params, ctx): Promise<{ versions: CodemodeLibVersion[] }> => {
        const lib = await open(ctx, params.projectRoot)
        return { versions: await lib.store.history(params.name, params.scope) }
      }
    }),
    defineMethod({
      name: 'codemode.lib.delete',
      permission: 'workspace',
      params: CodemodeLibTarget,
      handler: async (params, ctx): Promise<Record<string, never>> => {
        const lib = await open(ctx, params.projectRoot)
        // The store copies the file to .history before it unlinks it.
        await lib.store.remove(params.name, params.scope)
        await lib.trust.forget(await keyFor(lib, params.scope), params.name)
        return {}
      }
    }),
    defineMethod({
      name: 'codemode.lib.move',
      permission: 'workspace',
      params: CodemodeLibMove,
      handler: async (params, ctx): Promise<CodemodeLibEntryView> => {
        const lib = await open(ctx, params.projectRoot)
        const before = await requireFunction(lib, params.name, params.from)
        const oldKey = await keyFor(lib, params.from)
        const was = await lib.trust.state(oldKey, before.name, before.source)
        const moved = await lib.store.move(params.name, params.from)
        // Why: a move carries trust over, never grants it; Allow is the only way to trust here.
        if (was === 'trusted') {
          await lib.trust.record(await keyFor(lib, moved.scope), moved.name, moved.source)
        }
        await lib.trust.forget(oldKey, params.name)
        return viewOf(lib, moved, false)
      }
    }),
    defineMethod({
      // Why: a function too long for a chat card can only be allowed here, after reading it in View.
      name: 'codemode.lib.trust',
      permission: 'workspace',
      params: CodemodeLibTrust,
      handler: async (params, ctx): Promise<Record<string, never>> => {
        const lib = await open(ctx, params.projectRoot)
        const fn = await requireFunction(lib, params.name, params.scope)
        // Why: allow only the bytes the person read; a file edited since then asks again.
        if (libSourceHash(fn.source) !== params.sha256) {
          throw new Error('function changed since you viewed it; open it again')
        }
        await lib.trust.record(await keyFor(lib, fn.scope), fn.name, fn.source)
        return {}
      }
    })
  ]
}

export const CODEMODE_LIB_METHODS = codemodeLibMethods(RUNTIME_DEPS)
