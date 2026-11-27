import { describe, expect, it } from 'vitest'
import {
  appendBoundedCodeBlockOutput,
  formatCodeBlockRunChatPrompt,
  formatCodeBlockRunDuration,
  sanitizeCodeBlockRunChunk
} from './native-chat-code-block-output'

describe('native-chat code block run output', () => {
  it('strips ANSI escapes and control bytes while preserving newlines and tabs', () => {
    const raw = '\u001b[32mPASS\u001b[0m\tsuite\r\n\u001b]0;title\u0007line 2\rline 3\u0007'
    expect(sanitizeCodeBlockRunChunk(raw)).toBe('PASS\tsuite\nline 2\nline 3')
  })

  it('keeps the latest tail and latches truncated once output exceeds maxChars', () => {
    const first = appendBoundedCodeBlockOutput('', 'abcdef', false, 8)
    expect(first).toEqual({ output: 'abcdef', truncated: false })

    const second = appendBoundedCodeBlockOutput(first.output, 'ghij', first.truncated, 8)
    expect(second).toEqual({ output: 'cdefghij', truncated: true })

    const third = appendBoundedCodeBlockOutput(second.output, '', second.truncated, 8)
    expect(third).toEqual({ output: 'cdefghij', truncated: true })
  })

  it('formats durations across ms, seconds, and minutes', () => {
    expect(formatCodeBlockRunDuration(42)).toBe('42ms')
    expect(formatCodeBlockRunDuration(1_250)).toBe('1.3s')
    expect(formatCodeBlockRunDuration(61_000)).toBe('1m 1s')
    expect(formatCodeBlockRunDuration(119_600)).toBe('2m 0s')
  })

  it('formats failed and succeeded prompts with bounded output tails', () => {
    const failed = formatCodeBlockRunChatPrompt({
      command: 'pnpm test',
      language: 'bash',
      status: 'failed',
      exitCode: 1,
      signal: null,
      output: '0123456789abcdefghij',
      maxOutputChars: 10
    })
    expect(failed).toContain('This command failed (exit 1):')
    expect(failed).toContain('```bash\npnpm test\n```')
    expect(failed).toContain('... [earlier output omitted]\nabcdefghij')
    expect(failed).toContain('Please diagnose the failure and fix it.')

    const succeeded = formatCodeBlockRunChatPrompt({
      command: 'echo ok',
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      output: ''
    })
    expect(succeeded).toContain('I ran this command and it succeeded:')
    expect(succeeded).toContain('Output: (no output)')
    expect(succeeded).not.toContain('Please diagnose')
  })
})
