import { createNativeChatVisualsDelivery } from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import { resolveNativeChatCompressionSkillLocation } from '../../../native-chat/conversation-files/native-chat-compression-skill-location'
import type { StructuredAgentAdapterContext } from '../installation/structured-agent-runtime-registration-types'
import type { StructuredAgentLaunchSources } from './structured-agent-launch-composition'

/** The shared launch inputs of the runtime an agent's adapter is built in. */
export function structuredAgentLaunchSources(
  context: Pick<StructuredAgentAdapterContext, 'deps' | 'store' | 'environment' | 'codemode'>
): StructuredAgentLaunchSources {
  const { deps } = context
  return {
    store: context.store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    resolveBaseEnvironment: context.environment.resolveBaseEnvironment,
    resolveAgentEnvironment: context.environment.resolveAgentEnvironment,
    refreshAfterMissingProgram: context.environment.refreshAfterMissingProgram,
    ...(deps.resolveAgentLaunchEnv ? { resolveAgentLaunchEnv: deps.resolveAgentLaunchEnv } : {}),
    ...(deps.resolveAgentCommandSettings
      ? { resolveCommandSettings: deps.resolveAgentCommandSettings }
      : {}),
    ...(deps.resolveSessionInstructions
      ? { resolveInstructions: deps.resolveSessionInstructions }
      : {}),
    ...(deps.readOnlySession ? { readOnlySession: deps.readOnlySession } : {}),
    ...(deps.resolveSessionToolServers
      ? { resolveToolServers: deps.resolveSessionToolServers }
      : {}),
    ...(deps.prepareSessionLaunch ? { prepareLaunch: deps.prepareSessionLaunch } : {}),
    ...(deps.resolveSessionLinkedSkills
      ? { resolveLinkedSkills: deps.resolveSessionLinkedSkills }
      : {}),
    ...(deps.reportSessionLinkedSkills
      ? { reportLinkedSkills: deps.reportSessionLinkedSkills }
      : {}),
    ...(context.codemode ? { codemode: context.codemode } : {}),
    // Wired by the real hosts only, so a test runtime never loads the bundled skill.
    ...(deps.nativeChatVisuals
      ? {
          prepareVisuals: createNativeChatVisualsDelivery({
            stateDirectory: deps.stateDirectory,
            logger: deps.logger,
            isEnabled: deps.nativeChatVisuals.isEnabled
          }),
          resolveCompressionSkill: () => resolveNativeChatCompressionSkillLocation()
        }
      : {})
  }
}
