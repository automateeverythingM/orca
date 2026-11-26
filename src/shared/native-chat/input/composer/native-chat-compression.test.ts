import { describe, expect, it } from 'vitest'
import {
  applyNativeChatCompressionToSend,
  isCompressionResetCommand,
  resolveNativeChatCompressionSkill
} from './native-chat-compression'

describe('native-chat compression skill auto-loading', () => {
  it('resolves reported harness skill names and file refs before falling back per agent', () => {
    expect(
      resolveNativeChatCompressionSkill('codex', [
        { name: 'orca-compression', path: '/orca/skills/orca-compression/SKILL.md' }
      ])
    ).toEqual({
      token: '$orca-compression',
      skillRef: { name: 'orca-compression', path: '/orca/skills/orca-compression/SKILL.md' }
    })

    expect(
      resolveNativeChatCompressionSkill('claude', [
        { name: 'orca-native-compression:orca-compression' }
      ])
    ).toEqual({
      token: '/orca-native-compression:orca-compression'
    })

    expect(resolveNativeChatCompressionSkill('claude')).toEqual({
      token: '/orca-native-compression:orca-compression'
    })
    expect(resolveNativeChatCompressionSkill('codex')).toEqual({
      token: '$orca-compression'
    })
    expect(resolveNativeChatCompressionSkill('pi')).toEqual({
      token: '/skill:orca-compression'
    })
    expect(resolveNativeChatCompressionSkill('opencode')).toEqual({
      token: '/orca-compression'
    })
  })

  it('auto-loads the skill only on mode transitions and preserves user text and existing skills', () => {
    const first = applyNativeChatCompressionToSend({
      mode: 'terra',
      appliedMode: 'off',
      text: 'Explain auth flow',
      hasAttachments: false,
      isCommand: false,
      agent: 'claude'
    })
    expect(first).toEqual({
      text: '/orca-native-compression:orca-compression terra\n\nExplain auth flow',
      skills: [],
      nextAppliedMode: 'terra'
    })

    // Subsequent turns in the same mode do not re-expand SKILL.md.
    const second = applyNativeChatCompressionToSend({
      mode: 'terra',
      appliedMode: 'terra',
      text: 'Now refactor it',
      hasAttachments: false,
      isCommand: false,
      agent: 'claude'
    })
    expect(second).toEqual({
      text: 'Now refactor it',
      skills: [],
      nextAppliedMode: 'terra'
    })

    // Switching terra -> ultra injects the new mode and attaches Codex skillRef.
    const upgrade = applyNativeChatCompressionToSend({
      mode: 'ultra',
      appliedMode: 'terra',
      text: 'Fix tests',
      hasAttachments: false,
      isCommand: false,
      agent: 'codex',
      sessionSkills: [{ name: 'orca-compression', path: '/res/orca-compression/SKILL.md' }],
      existingSkills: [{ name: 'review', path: '/repo/review/SKILL.md' }]
    })
    expect(upgrade).toEqual({
      text: '$orca-compression ultra\n\nFix tests',
      skills: [
        { name: 'orca-compression', path: '/res/orca-compression/SKILL.md' },
        { name: 'review', path: '/repo/review/SKILL.md' }
      ],
      nextAppliedMode: 'ultra'
    })

    // Turning compression off tells the skill to restore normal verbosity once.
    const turnOff = applyNativeChatCompressionToSend({
      mode: 'off',
      appliedMode: 'ultra',
      text: 'Write full RFC',
      hasAttachments: false,
      isCommand: false,
      agent: 'opencode'
    })
    expect(turnOff).toEqual({
      text: '/orca-compression off\n\nWrite full RFC',
      skills: [],
      nextAppliedMode: 'off'
    })
  })

  it('never wraps slash commands or empty drafts without attachments', () => {
    expect(
      applyNativeChatCompressionToSend({
        mode: 'ultra',
        appliedMode: 'off',
        text: '/compact',
        hasAttachments: false,
        isCommand: true,
        agent: 'claude'
      })
    ).toEqual({ text: '/compact', skills: [], nextAppliedMode: 'off' })

    expect(
      applyNativeChatCompressionToSend({
        mode: 'ultra',
        appliedMode: 'off',
        text: '   ',
        hasAttachments: false,
        isCommand: false,
        agent: 'claude'
      })
    ).toEqual({ text: '   ', skills: [], nextAppliedMode: 'off' })

    expect(
      applyNativeChatCompressionToSend({
        mode: 'ultra',
        appliedMode: 'off',
        text: '',
        hasAttachments: true,
        isCommand: false,
        agent: 'claude'
      })
    ).toEqual({
      text: '/orca-native-compression:orca-compression ultra',
      skills: [],
      nextAppliedMode: 'ultra'
    })
  })

  it('detects conversation-clearing commands that reset applied compression', () => {
    expect(isCompressionResetCommand('/clear', 'claude')).toBe(true)
    expect(isCompressionResetCommand('/new', 'codex')).toBe(true)
    expect(isCompressionResetCommand('/new', 'claude')).toBe(false)
    expect(isCompressionResetCommand('/compact', 'claude')).toBe(false)
    expect(isCompressionResetCommand('clear the cache', 'claude')).toBe(false)
  })
})
