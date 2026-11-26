// Resolve on the execution host; a client’s install paths are meaningless remotely.

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import type { NativeChatSkillRoot } from '../native-chat-skill-roots'

const PLUGIN_DIR_NAME = 'native-chat-compression'
export const NATIVE_CHAT_COMPRESSION_SKILL_NAME = 'orca-compression'

/** Its pluginDir contains .claude-plugin/plugin.json and skills/<name>/SKILL.md. */
export type NativeChatCompressionSkillLocation = NativeChatSkillRoot

function candidatePluginDirs(): string[] {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, PLUGIN_DIR_NAME))
  }
  const packaged = hasAppEnvironment() && getAppEnvironment().isPackaged()
  if (packaged) {
    // Plain-Node orcad uses its app root; packaged installs must never fall back to launch-directory checkouts.
    candidates.push(join(getAppEnvironment().getAppPath(), PLUGIN_DIR_NAME))
    return candidates
  }
  for (const root of [
    hasAppEnvironment() ? getAppEnvironment().getAppPath() : null,
    process.cwd()
  ]) {
    if (root) {
      candidates.push(join(root, 'resources', PLUGIN_DIR_NAME))
    }
  }
  return candidates
}

async function isComplete(pluginDir: string): Promise<boolean> {
  try {
    await Promise.all([
      access(join(pluginDir, '.claude-plugin', 'plugin.json')),
      access(join(pluginDir, 'skills', NATIVE_CHAT_COMPRESSION_SKILL_NAME, 'SKILL.md'))
    ])
    return true
  } catch {
    return false
  }
}

let found: NativeChatCompressionSkillLocation | null = null

/** Cache only found locations so missing plugins can appear later. */
export async function resolveNativeChatCompressionSkillLocation(
  candidates: readonly string[] = candidatePluginDirs()
): Promise<NativeChatCompressionSkillLocation | null> {
  if (found) {
    return found
  }
  for (const pluginDir of candidates) {
    if (await isComplete(pluginDir)) {
      found = { pluginDir, skillsRoot: join(pluginDir, 'skills') }
      return found
    }
  }
  return null
}

/** Standing instructions that point an agent which cannot load skills at the compression skill. */
export function nativeChatCompressionSection(skill: NativeChatCompressionSkillLocation): string {
  const file = join(skill.skillsRoot, NATIVE_CHAT_COMPRESSION_SKILL_NAME, 'SKILL.md')
  return [
    '## Response compression',
    '',
    `When a user message begins with /${NATIVE_CHAT_COMPRESSION_SKILL_NAME} or $${NATIVE_CHAT_COMPRESSION_SKILL_NAME} followed by terra, ultra, or off, read ${file} first and follow that compression mode for the message and all subsequent replies until changed or turned off.`
  ].join('\n')
}
