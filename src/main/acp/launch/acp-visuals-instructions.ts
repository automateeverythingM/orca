// Agents that cannot load Orca's bundled skills learn of them from their standing instructions.

import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { nativeChatVisualsSection } from '../../native-chat/conversation-files/native-chat-visuals-delivery'
import type { NativeChatVisualsSkillLocation } from '../../native-chat/conversation-files/native-chat-visuals-skill-location'
import {
  nativeChatCompressionSection,
  type NativeChatCompressionSkillLocation
} from '../../native-chat/conversation-files/native-chat-compression-skill-location'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { acpLaunchInstructions, type AcpInstructionsLaunch } from './acp-instructions'

/** Whether the visuals skill may reach this agent through its standing instructions. */
export function visualsByInstructions(spec: AcpLaunchSpec): boolean {
  return spec.instructions !== undefined && !spec.instructionsInWorkspace
}

/** Adds bundled skill sections for unloaded skills; they never stop a chat that would start without them. */
export async function acpInstructionsWithVisuals(
  spec: AcpLaunchSpec,
  deps: { dataDirectory: string; logger?: StructuredAgentSessionLogger },
  input: Parameters<typeof acpLaunchInstructions>[2],
  unloadedSkill: NativeChatVisualsSkillLocation | null,
  unloadedCompressionSkill: NativeChatCompressionSkillLocation | null = null
): Promise<{ launch: AcpInstructionsLaunch | null; visuals: boolean }> {
  const sections = [
    ...(unloadedSkill ? [nativeChatVisualsSection(unloadedSkill)] : []),
    ...(unloadedCompressionSkill ? [nativeChatCompressionSection(unloadedCompressionSkill)] : [])
  ]
  if (sections.length > 0 && visualsByInstructions(spec)) {
    const added = sections.join('\n\n')
    try {
      const launch = await acpLaunchInstructions(spec, deps.dataDirectory, {
        ...input,
        text: input.text ? `${input.text}\n\n${added}` : added
      })
      return {
        launch: launch && !input.text ? { ...launch, sessionMetaOptional: true } : launch,
        visuals: unloadedSkill !== null
      }
    } catch (error) {
      deps.logger?.warn(
        `${spec.agent} cannot take the bundled skill instructions; the chat starts without them`,
        {
          scope: 'nativeChatVisuals.acp',
          sessionId: input.sessionId,
          error
        }
      )
    }
  }
  return { launch: await acpLaunchInstructions(spec, deps.dataDirectory, input), visuals: false }
}
