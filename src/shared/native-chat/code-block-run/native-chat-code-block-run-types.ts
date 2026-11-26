export type NativeChatCodeBlockRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export type NativeChatCodeBlockRunFrame =
  | { type: 'started'; cwd: string }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | {
      type: 'exit'
      status: Exclude<NativeChatCodeBlockRunStatus, 'running'>
      exitCode: number | null
      signal: string | null
      durationMs: number
      truncated: boolean
      error?: string
    }

export const NATIVE_CHAT_CODE_BLOCK_MAX_OUTPUT_CHARS = 256 * 1024
