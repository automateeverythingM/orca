// What decides which commands and skills Claude loads. A chat's launch and its resting `/` probe
// both take these, so the menu at rest lists what the chat would load.
import type { NativeChatSkillRoot } from '../../../native-chat/native-chat-skill-roots'
import { claudeStructuredLaunchArgs } from './claude-structured-launch-args'

export const CLAUDE_DEFAULT_SETTING_SOURCES = ['user', 'project', 'local'] as const

/** Shaped as the SDK takes them; a launch's own `extraArgs` go on top of the configured ones. */
export type ClaudeDiscoveryOptions = {
  additionalDirectories: string[]
  /** Only the visuals plugin; absent when it doesn't load, as the SDK's default. */
  plugins?: { type: 'local'; path: string }[]
  settingSources: (typeof CLAUDE_DEFAULT_SETTING_SOURCES)[number][]
  extraArgs: Record<string, string | null>
}

export function claudeDiscoveryOptions(input: {
  /** The user's saved Arguments for Claude. */
  configuredArgs: readonly string[]
  attachmentDirectory?: string
  /** Visuals, when on: the bundled plugin (null when the CLI takes no plugin folders), and the
   *  chat's own scratch folder, for its launch only, which holds the chat's output, not skills. */
  visuals?: { pluginDir: string | null; scratchDirectory?: string } | null
  /** Additional Orca-bundled plugin folders (e.g. compression) when the CLI supports `--plugin-dir`. */
  extraPluginDirs?: readonly string[]
  linkedRoot?: NativeChatSkillRoot | null
}): ClaudeDiscoveryOptions {
  const configured = claudeStructuredLaunchArgs(input.configuredArgs)
  const pluginDirs = [
    ...(input.visuals?.pluginDir ? [input.visuals.pluginDir] : []),
    ...(input.extraPluginDirs ?? [])
  ]
  return {
    additionalDirectories: [
      ...configured.additionalDirectories,
      ...(input.attachmentDirectory ? [input.attachmentDirectory] : []),
      ...(input.visuals?.scratchDirectory ? [input.visuals.scratchDirectory] : []),
      // The bot's skill-only folder, even empty: Claude loads its .claude/skills links and picks up
      // later ones (checked on 2.1.319), and it holds no project settings, plugins or commands.
      ...(input.linkedRoot ? [input.linkedRoot.pluginDir] : [])
    ],
    ...(pluginDirs.length > 0
      ? { plugins: pluginDirs.map((path) => ({ type: 'local' as const, path })) }
      : {}),
    settingSources: [...CLAUDE_DEFAULT_SETTING_SOURCES],
    extraArgs: configured.extraArgs
  }
}

/** The same options as Claude CLI flags, for a probe that runs the CLI directly. */
export function claudeDiscoveryArgs(options: ClaudeDiscoveryOptions): string[] {
  return [
    ...Object.entries(options.extraArgs).flatMap(([flag, value]) =>
      value === null ? [`--${flag}`] : [`--${flag}`, value]
    ),
    ...options.additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
    ...(options.plugins ?? []).flatMap((plugin) => ['--plugin-dir', plugin.path]),
    `--setting-sources=${options.settingSources.join(',')}`
  ]
}
