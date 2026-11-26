import * as z from 'zod'

// A script's shape hash or a chain's key, as `codemode.learn.list` gave it. A chain's key is its
// signature up to 1 KiB and a hash past that, so no key is longer than 1024 characters.
export const CodemodeLearnDismiss = z.strictObject({
  key: z.string().min(1).max(1024)
})

// A Learn run: optionally only one chat's scripts and/or one shape (a script's shape hash or a
// chain's key); the hint is cut to 500 characters before it reaches the writer.
export const CodemodeLearnPropose = z.strictObject({
  sessionId: z.string().min(1).max(256).optional(),
  shape: z.string().min(1).max(1024).optional(),
  hint: z.string().max(2000).optional()
})

export const CodemodeLearnProposalId = z.strictObject({
  id: z.string().min(1).max(64)
})

// `source` is the person's edit of the proposal's whole file text; the lib store validates it.
export const CodemodeLearnSaveProposal = z.strictObject({
  id: z.string().min(1).max(64),
  scope: z.enum(['project', 'global']),
  source: z
    .string()
    .min(1)
    .max(256 * 1024)
    .optional()
})
