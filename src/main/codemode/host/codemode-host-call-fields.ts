import { trimOutput } from '../sandbox/codemode-output-trim'

/** A host call's input object, as the sandbox sent it (untrusted). */
export type Fields = Record<string, unknown>

const DETAIL_BYTES = 2_000

export function isFields(input: unknown): input is Fields {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

export function fieldsOf(tool: string, input: unknown): Fields {
  if (!isFields(input)) {
    throw new Error(`${tool}: expected an object argument`)
  }
  return input
}

export function text(tool: string, fields: Fields, key: string): string {
  const value = fields[key]
  if (typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a string`)
  }
  return value
}

export function optionalText(tool: string, fields: Fields, key: string): string | undefined {
  return fields[key] === undefined ? undefined : text(tool, fields, key)
}

export function optionalNumber(tool: string, fields: Fields, key: string): number | undefined {
  const value = fields[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${tool}: ${key} must be a number`)
  }
  return value
}

/** Approval-card detail text, trimmed to 2 KB. */
export function clipDetail(value: string): string {
  return trimOutput(value, DETAIL_BYTES)
}
