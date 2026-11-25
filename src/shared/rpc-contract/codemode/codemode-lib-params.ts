import * as z from 'zod'
import { CODEMODE_LIB_NAME } from '../../codemode/codemode-lib-types'

const Name = z.string().regex(CODEMODE_LIB_NAME, 'Unknown function')
const Scope = z.enum(['project', 'global'])
// Main checks the root is an Orca worktree before any file access; this only bounds the text.
const ProjectRoot = z.string().min(1).max(4096).optional()

export const CodemodeLibList = z.strictObject({ projectRoot: ProjectRoot })

export const CodemodeLibTarget = z.strictObject({
  name: Name,
  scope: Scope,
  projectRoot: ProjectRoot
})

// The store checks the version's form, so a bad one fails with its words before any read.
export const CodemodeLibRead = z.strictObject({
  name: Name,
  scope: Scope,
  version: z.string().min(1).max(64).optional(),
  projectRoot: ProjectRoot
})

// The hash of the bytes the person viewed; main refuses when the file no longer matches it.
export const CodemodeLibTrust = z.strictObject({
  name: Name,
  scope: Scope,
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Open the function again'),
  projectRoot: ProjectRoot
})

export const CodemodeLibMove = z.strictObject({
  name: Name,
  from: Scope,
  projectRoot: ProjectRoot
})
