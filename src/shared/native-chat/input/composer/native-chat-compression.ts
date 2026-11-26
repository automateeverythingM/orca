import type { AgentJournalSkillRef } from '../../../agent-session/journal/agent-session-journal-types'
import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import { getNativeChatAgentProfile } from '../commands/native-chat-agent-profiles'
import type { NativeChatSessionSkill } from '../commands/native-chat-slash-commands'

export type NativeChatCompressionMode = 'off' | 'terra' | 'ultra'

export const NATIVE_CHAT_COMPRESSION_MODES: readonly NativeChatCompressionMode[] = [
  'off',
  'terra',
  'ultra'
]

export const NATIVE_CHAT_COMPRESSION_SKILL_NAME = 'orca-compression'
export const NATIVE_CHAT_COMPRESSION_CLAUDE_PLUGIN_NAME = 'orca-native-compression'

export type ResolvedNativeChatCompressionSkill = {
  token: string
  skillRef?: AgentJournalSkillRef
}

function isCompressionSkillName(name: string): boolean {
  return (
    name === NATIVE_CHAT_COMPRESSION_SKILL_NAME ||
    name.endsWith(`:${NATIVE_CHAT_COMPRESSION_SKILL_NAME}`)
  )
}

/** Resolve the agent-native skill token and optional file ref for Orca's bundled compression skill. */
export function resolveNativeChatCompressionSkill(
  agent: AgentType,
  sessionSkills?: readonly NativeChatSessionSkill[]
): ResolvedNativeChatCompressionSkill {
  const profile = getNativeChatAgentProfile(agent)
  const sigil = profile?.skillPrefix ?? '/'
  const reported = sessionSkills?.find((skill) => isCompressionSkillName(skill.name))
  if (reported) {
    return {
      token: `${sigil}${reported.name}`,
      ...(reported.path ? { skillRef: { name: reported.name, path: reported.path } } : {})
    }
  }
  if (agent === 'claude' || agent === 'openclaude') {
    return {
      token: `/${NATIVE_CHAT_COMPRESSION_CLAUDE_PLUGIN_NAME}:${NATIVE_CHAT_COMPRESSION_SKILL_NAME}`
    }
  }
  const namePrefix = profile?.skillNamePrefix ?? ''
  return { token: `${sigil}${namePrefix}${NATIVE_CHAT_COMPRESSION_SKILL_NAME}` }
}

/** Whether a submitted command clears conversation context so compression must re-load on the next turn. */
export function isCompressionResetCommand(text: string, agent?: AgentType): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) {
    return false
  }
  const command = trimmed.slice(1).split(/\s/, 1)[0]?.toLowerCase()
  return command === 'clear' || (agent === 'codex' && command === 'new')
}

export type AppliedNativeChatCompression = {
  text: string
  skills: readonly AgentJournalSkillRef[]
  nextAppliedMode: NativeChatCompressionMode
}

/**
 * Auto-load the bundled compression skill only when the chat's compression mode transitions
 * (e.g. off -> terra/ultra, terra <-> ultra, or active -> off), avoiding redundant SKILL.md
 * expansion on subsequent turns in the same mode.
 */
export function applyNativeChatCompressionToSend(input: {
  mode: NativeChatCompressionMode
  appliedMode: NativeChatCompressionMode
  text: string
  hasAttachments: boolean
  isCommand: boolean
  agent: AgentType
  sessionSkills?: readonly NativeChatSessionSkill[]
  existingSkills?: readonly AgentJournalSkillRef[]
}): AppliedNativeChatCompression {
  const {
    mode,
    appliedMode,
    text,
    hasAttachments,
    isCommand,
    agent,
    sessionSkills,
    existingSkills = []
  } = input
  if (isCommand || mode === appliedMode || (text.trim() === '' && !hasAttachments)) {
    return { text, skills: existingSkills, nextAppliedMode: appliedMode }
  }
  const resolved = resolveNativeChatCompressionSkill(agent, sessionSkills)
  const invocation = `${resolved.token} ${mode}`
  const body = text.trimStart()
  const nextText = body.length > 0 ? `${invocation}\n\n${body}` : invocation
  const skills =
    resolved.skillRef && !existingSkills.some((skill) => skill.path === resolved.skillRef!.path)
      ? [resolved.skillRef, ...existingSkills]
      : existingSkills
  return {
    text: nextText,
    skills,
    nextAppliedMode: mode
  }
}
