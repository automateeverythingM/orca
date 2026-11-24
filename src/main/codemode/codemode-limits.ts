export const CODEMODE_LIMITS = {
  jsTimeMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  maxCalls: 500,
  outputBytes: 30_000,
  resultBytes: 4 * 1024 * 1024,
  bashDefaultMs: 120_000,
  bashMaxMs: 600_000,
  progressMs: 20_000
} as const

export type CodemodeLimits = { readonly [K in keyof typeof CODEMODE_LIMITS]: number }
