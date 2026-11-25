import * as z from 'zod'

// A script's shape hash or a chain's signature, as `codemode.learn.list` gave it. A chain's signature
// grows with its calls, so this only bounds the text; the store matches it exactly.
export const CodemodeLearnDismiss = z.strictObject({
  key: z.string().min(1).max(65_536)
})
