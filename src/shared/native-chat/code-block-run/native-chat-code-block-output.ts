import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../terminal/protocol/escape/ansi-escape-sequences'
import { NATIVE_CHAT_CODE_BLOCK_MAX_OUTPUT_CHARS } from './native-chat-code-block-run-types'

/** Normalize raw process output into readable plain text for inline chat display. */
export function sanitizeCodeBlockRunChunk(raw: string): string {
  if (!raw) {
    return ''
  }
  const withoutAnsi = stripAnsiEscapeSequences(raw)
  const normalizedLines = withoutAnsi.replace(/\r\n?/g, '\n')
  return normalizedLines.replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}

/** Append sanitized output while keeping only the latest `maxChars` tail so huge logs stay bounded. */
export function appendBoundedCodeBlockOutput(
  current: string,
  addition: string,
  alreadyTruncated: boolean,
  maxChars = NATIVE_CHAT_CODE_BLOCK_MAX_OUTPUT_CHARS
): { output: string; truncated: boolean } {
  if (!addition) {
    return { output: current, truncated: alreadyTruncated }
  }
  const combined = current + addition
  if (combined.length <= maxChars) {
    return { output: combined, truncated: alreadyTruncated }
  }
  // Keep the tail because errors and final exit summaries appear at the end of command output.
  return {
    output: combined.slice(combined.length - maxChars),
    truncated: true
  }
}

export const NATIVE_CHAT_CODE_BLOCK_PROMPT_OUTPUT_CHARS = 12 * 1024

export function formatCodeBlockRunDuration(durationMs: number): string {
  const safeMs = Math.max(0, Math.round(durationMs))
  if (safeMs < 1_000) {
    return `${safeMs}ms`
  }
  const seconds = safeMs / 1_000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainderSeconds = Math.round(seconds % 60)
  return remainderSeconds === 60 ? `${minutes + 1}m 0s` : `${minutes}m ${remainderSeconds}s`
}

/** Format an inline shell run's command, status, and bounded output tail for the agent chat. */
export function formatCodeBlockRunChatPrompt(input: {
  command: string
  language?: string
  status: 'succeeded' | 'failed' | 'cancelled'
  exitCode: number | null
  signal: string | null
  output: string
  error?: string
  maxOutputChars?: number
}): string {
  const maxOutputChars = input.maxOutputChars ?? NATIVE_CHAT_CODE_BLOCK_PROMPT_OUTPUT_CHARS
  const fenceLang = input.language?.trim() || 'bash'
  const header =
    input.status === 'failed'
      ? input.exitCode !== null
        ? `This command failed (exit ${input.exitCode}):`
        : input.signal
          ? `This command failed (${input.signal}):`
          : 'This command failed:'
      : input.status === 'cancelled'
        ? 'I ran this command and stopped it:'
        : 'I ran this command and it succeeded:'

  const trimmedOutput = input.output.trimEnd()
  const rawBody =
    trimmedOutput && input.error
      ? `${trimmedOutput}\n${input.error}`
      : trimmedOutput || input.error || ''

  const body =
    rawBody.length > maxOutputChars
      ? `... [earlier output omitted]\n${rawBody.slice(rawBody.length - maxOutputChars)}`
      : rawBody

  const parts = [header, `\`\`\`${fenceLang}\n${input.command}\n\`\`\``]
  if (body) {
    parts.push(`Output:\n\`\`\`text\n${body}\n\`\`\``)
  } else {
    parts.push('Output: (no output)')
  }
  if (input.status === 'failed') {
    parts.push('Please diagnose the failure and fix it.')
  }
  return parts.join('\n\n')
}
