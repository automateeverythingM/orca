import { READ_CHECK } from '../host/codemode-approvals'
import { clipDetail, type Fields, text } from '../host/codemode-host-call-fields'
import type { PlannedHostCall } from '../host/codemode-host-dispatch'
import { describeOrca } from './codemode-orca-describe'
import { checkOrcaParams, exposedOrcaMethod, type OrcaRpcAccess } from './codemode-orca-dispatch'

export const ORCA_UNAVAILABLE_TEXT = 'Orca actions are not available in this chat'

function detailOf(params: unknown): string {
  return clipDetail(JSON.stringify(params ?? null, null, 2))
}

/** Plans `orca.areas`, `orca.describe`, `orca.context` (reads) and `orca.call` (gated by label). */
export function planOrcaHostCall(
  tool: string,
  fields: Fields,
  orca: OrcaRpcAccess | undefined,
  signal: AbortSignal
): PlannedHostCall {
  if (!orca) {
    throw new Error(ORCA_UNAVAILABLE_TEXT)
  }
  switch (tool) {
    case 'orca.areas':
      return { ...READ_CHECK, execute: async () => ({ ok: true, value: orca.index().areas() }) }
    case 'orca.describe': {
      const target = text(tool, fields, 'target')
      return {
        ...READ_CHECK,
        execute: async () => ({ ok: true, value: describeOrca(orca.index(), target) })
      }
    }
    case 'orca.context':
      return { ...READ_CHECK, execute: async () => ({ ok: true, value: orca.context() }) }
    case 'orca.call': {
      const method = text(tool, fields, 'method')
      const entry = exposedOrcaMethod(orca.index(), method)
      const { params } = fields
      // Why: a bad call fails here, before anyone is asked to approve it.
      checkOrcaParams(entry, params)
      return {
        gate: { kind: 'orca', label: entry.label },
        // Destructive calls are never remembered, so allow_session still asks next time.
        allowKey: entry.label === 'destructive' ? null : `orca:${entry.name}`,
        prompt: { title: `Orca: ${entry.name}`, detail: detailOf(params) },
        execute: async () => ({ ok: true, value: await orca.call(entry.name, params, signal) })
      }
    }
    default:
      throw new Error(`unknown host tool ${tool}`)
  }
}
