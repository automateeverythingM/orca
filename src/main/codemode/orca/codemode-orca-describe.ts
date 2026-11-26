import { z } from 'zod'
import { unwrapLazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
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

/** `seen` keyed by the schema a lazy contract stands for, so its proxy and the schema are one entry. */
class LazyContractSeen<V> extends Map<z.core.$ZodType, V> {
  override get(key: z.core.$ZodType): V | undefined {
    return super.get(unlazy(key))
  }
  override set(key: z.core.$ZodType, value: V): this {
    return super.set(unlazy(key), value)
  }
  override has(key: z.core.$ZodType): boolean {
    return super.has(unlazy(key))
  }
}

const unlazy = (schema: z.core.$ZodType): z.core.$ZodType =>
  schema instanceof z.ZodType ? unwrapLazyZodSchema(schema) : schema

/**
 * `z.toJSONSchema` of what a caller passes. Upstream's lazy contracts are Proxies nested anywhere in
 * a schema, and each schema's own processor looks itself up by its real identity, so the walk keys
 * every schema by the one a proxy stands for. Each classic schema carries its own processor.
 */
function inputJsonSchema(params: z.ZodType): unknown {
  const ctx = z.core.initializeContext({
    processors: {},
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any'
  })
  ctx.seen = new LazyContractSeen()
  const root = unwrapLazyZodSchema(params)
  z.core.processSchema(root, ctx)
  z.core.extractDefs(ctx, root)
  return z.core.finalize(ctx, root)
}

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
    converted = inputJsonSchema(entry.params)
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
