import * as z from 'zod'

// A script's shape hash or a chain's key, as `codemode.learn.list` gave it. A chain's key is its
// signature up to 1 KiB and a hash past that, so no key is longer than 1024 characters.
export const CodemodeLearnDismiss = z.strictObject({
  key: z.string().min(1).max(1024)
})
