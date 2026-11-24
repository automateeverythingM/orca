import { z } from 'zod'
import type { OrcaMethodEntry, OrcaMethodIndex } from './codemode-orca-method-index'
import type { OrcaMethodLabel } from './codemode-orca-method-policy'

export type OrcaMethodDescription = {
  method: string
  label: OrcaMethodLabel
  params: unknown
}

const SCHEMA_UNAVAILABLE = { description: 'schema unavailable' }

// Why: converting ~hundreds of zod schemas is not free; a method's schema never
// changes at runtime, so cache by the schema object itself.
const schemaCache = new WeakMap<object, unknown>()

function paramsSchema(entry: OrcaMethodEntry): unknown {
  if (entry.params === null) {
    return null
  }
  const cached = schemaCache.get(entry.params)
  if (cached !== undefined) {
    return cached
  }
  let converted: unknown
  try {
    converted = z.toJSONSchema(entry.params, {
      io: 'input',
      target: 'draft-2020-12',
      unrepresentable: 'any'
    })
  } catch {
    converted = SCHEMA_UNAVAILABLE
  }
  schemaCache.set(entry.params, converted)
  return converted
}

/** Describe an area (`worktree`) or one method (`worktree.create`) for `orca.describe`. */
export function describeOrca(index: OrcaMethodIndex, target: string): OrcaMethodDescription[] {
  const single = index.get(target)
  const entries = single ? [single] : index.inArea(target)
  if (entries.length === 0) {
    throw new Error(`unknown Orca area or method: ${target}`)
  }
  return entries.map((entry) => ({
    method: entry.name,
    label: entry.label,
    params: paramsSchema(entry)
  }))
}
