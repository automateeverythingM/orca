import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { PrepareNativeChatVisuals } from '../../native-chat/conversation-files/native-chat-visuals-delivery'
import type { AcpLaunchSpec } from './acp-launch-contract'
import type { AcpSkillRootsLaunch } from './acp-skill-roots'
import type { NativeChatSkillRoot } from '../../native-chat/native-chat-skill-roots'
import type { StructuredAgentLaunchBasis } from '../../runtime/agent-session/launch/structured-agent-launch-composition'
import { visualsByInstructions } from './acp-visuals-instructions'

/** Resolve visuals, compression, and linked-project skill folders in load order for an ACP launch. */
export async function resolveAcpBundledSkillInputs(
  spec: AcpLaunchSpec,
  basis: Pick<StructuredAgentLaunchBasis, 'visuals' | 'compressionSkill' | 'linkedSkills'>
) {
  const loadsBundled = Boolean(spec.skillRoots || visualsByInstructions(spec))
  const [visuals, compressionSkill, linked] = await Promise.all([
    loadsBundled ? basis.visuals() : null,
    loadsBundled ? basis.compressionSkill() : null,
    basis.linkedSkills()
  ])
  // Only a folder with skills: these agents read it once, so a later link reaches them as a list.
  const linkedRoot = linked.projects.length > 0 ? linked.root : null
  const roots: NativeChatSkillRoot[] = [
    ...(visuals ? [visuals.skill] : []),
    ...(compressionSkill ? [compressionSkill] : []),
    ...(linkedRoot ? [linkedRoot] : [])
  ]
  return { visuals, compressionSkill, linked, linkedRoot, roots }
}

export type AcpLaunchVisualsDeps = {
  prepareVisuals?: PrepareNativeChatVisuals
  logger?: StructuredAgentSessionLogger
}

/** What the child will see: inherited values under the launch's, less the removed keys. */
export function childEnvironmentView(
  env: Readonly<Record<string, string>>,
  inherited: NodeJS.ProcessEnv,
  envToDelete: readonly string[]
): Record<string, string> {
  const view: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) {
      view[key] = value
    }
  }
  Object.assign(view, env)
  for (const key of envToDelete) {
    delete view[key]
  }
  return view
}

/** Loading failures leave the chat without visuals and its linked skills in its instructions. */
export async function loadAcpSkillRoots(
  spec: AcpLaunchSpec,
  deps: AcpLaunchVisualsDeps,
  input: {
    sessionId: string
    roots: readonly NativeChatSkillRoot[]
    /** Orca's visuals skill, when it is one of the roots. */
    visualsRoot: NativeChatSkillRoot | null
    version: string | null
    env: Readonly<Record<string, string>>
    envToDelete: readonly string[]
    inherited: NodeJS.ProcessEnv
  }
): Promise<AcpSkillRootsLaunch | null> {
  const { skillRoots } = spec
  if (!skillRoots || input.roots.length === 0) {
    return null
  }
  try {
    const launch = await skillRoots({
      roots: input.roots,
      version: input.version,
      env: childEnvironmentView(input.env, input.inherited, input.envToDelete)
    })
    if (input.visualsRoot && !launch?.loaded.includes(input.visualsRoot)) {
      deps.logger?.warn(`${spec.agent} cannot load the visuals skill; the chat has no visuals`, {
        scope: 'nativeChatVisuals.acp',
        sessionId: input.sessionId,
        version: input.version
      })
    }
    return launch
  } catch (error) {
    deps.logger?.warn(`${spec.agent} skill folders could not be prepared`, {
      scope: 'nativeChatVisuals.acp',
      sessionId: input.sessionId,
      error
    })
    return null
  }
}
