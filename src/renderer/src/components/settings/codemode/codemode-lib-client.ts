// Saved functions (`lib.*`), read and changed on this computer's runtime (code mode is desktop-only).
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  CodemodeLibEntryView,
  CodemodeLibListView,
  CodemodeLibScope,
  CodemodeLibVersion
} from '../../../../../shared/codemode/codemode-lib-types'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

/** The worktree whose `.orca/lib` is the project scope; null shows global functions only. */
export type CodemodeLibProject = string | null

const withProject = (projectRoot: CodemodeLibProject): { projectRoot?: string } =>
  projectRoot ? { projectRoot } : {}

export function listCodemodeFunctions(
  projectRoot: CodemodeLibProject
): Promise<CodemodeLibListView> {
  return callRuntimeRpc<CodemodeLibListView>(LOCAL, 'codemode.lib.list', withProject(projectRoot))
}

export async function readCodemodeFunction(
  projectRoot: CodemodeLibProject,
  name: string,
  scope: CodemodeLibScope,
  version?: string
): Promise<{ source: string; sha256: string }> {
  return callRuntimeRpc<{ source: string; sha256: string }>(LOCAL, 'codemode.lib.read', {
    name,
    scope,
    ...(version ? { version } : {}),
    ...withProject(projectRoot)
  })
}

export async function codemodeFunctionHistory(
  projectRoot: CodemodeLibProject,
  name: string,
  scope: CodemodeLibScope
): Promise<CodemodeLibVersion[]> {
  const { versions } = await callRuntimeRpc<{ versions: CodemodeLibVersion[] }>(
    LOCAL,
    'codemode.lib.history',
    { name, scope, ...withProject(projectRoot) }
  )
  return versions
}

export async function deleteCodemodeFunction(
  projectRoot: CodemodeLibProject,
  name: string,
  scope: CodemodeLibScope
): Promise<void> {
  await callRuntimeRpc(LOCAL, 'codemode.lib.delete', { name, scope, ...withProject(projectRoot) })
}

export function moveCodemodeFunction(
  projectRoot: CodemodeLibProject,
  name: string,
  from: CodemodeLibScope
): Promise<CodemodeLibEntryView> {
  return callRuntimeRpc<CodemodeLibEntryView>(LOCAL, 'codemode.lib.move', {
    name,
    from,
    ...withProject(projectRoot)
  })
}

/** Allows the bytes the person viewed (their `sha256`); main refuses if the file changed since. */
export async function trustCodemodeFunction(
  projectRoot: CodemodeLibProject,
  name: string,
  scope: CodemodeLibScope,
  sha256: string
): Promise<void> {
  await callRuntimeRpc(LOCAL, 'codemode.lib.trust', {
    name,
    scope,
    sha256,
    ...withProject(projectRoot)
  })
}
