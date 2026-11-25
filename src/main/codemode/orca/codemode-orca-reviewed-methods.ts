// Why: the exposed orca.* set is a reviewed decision. Each upstream merge that adds, drops or
// relabels a method fails codemode-orca-reviewed-methods.test.ts until a person updates these tables.
import type { OrcaMethodLabel } from './codemode-orca-method-policy'
import { CODEMODE_ORCA_REVIEWED_AGENTS } from './reviewed/codemode-orca-reviewed-agents'
import { CODEMODE_ORCA_REVIEWED_BROWSER } from './reviewed/codemode-orca-reviewed-browser'
import { CODEMODE_ORCA_REVIEWED_INTEGRATIONS } from './reviewed/codemode-orca-reviewed-integrations'
import { CODEMODE_ORCA_REVIEWED_SOURCE_CONTROL } from './reviewed/codemode-orca-reviewed-source-control'
import { CODEMODE_ORCA_REVIEWED_WORKSPACE } from './reviewed/codemode-orca-reviewed-workspace'

export type OrcaReviewedTable = Readonly<Record<string, OrcaMethodLabel>>

/** Each data file, by path from this folder; a method of an area no file holds yet goes to the last. */
export const CODEMODE_ORCA_REVIEWED_FILES: readonly {
  file: string
  table: OrcaReviewedTable
}[] = [
  {
    file: 'reviewed/codemode-orca-reviewed-agents.ts',
    table: CODEMODE_ORCA_REVIEWED_AGENTS
  },
  {
    file: 'reviewed/codemode-orca-reviewed-browser.ts',
    table: CODEMODE_ORCA_REVIEWED_BROWSER
  },
  {
    file: 'reviewed/codemode-orca-reviewed-integrations.ts',
    table: CODEMODE_ORCA_REVIEWED_INTEGRATIONS
  },
  {
    file: 'reviewed/codemode-orca-reviewed-source-control.ts',
    table: CODEMODE_ORCA_REVIEWED_SOURCE_CONTROL
  },
  {
    file: 'reviewed/codemode-orca-reviewed-workspace.ts',
    table: CODEMODE_ORCA_REVIEWED_WORKSPACE
  }
]

/** Every method a script may call as `orca.<area>.<method>`, with its reviewed label, by name. */
export const CODEMODE_ORCA_REVIEWED_METHODS: OrcaReviewedTable = Object.fromEntries(
  CODEMODE_ORCA_REVIEWED_FILES.flatMap(({ table }) => Object.entries(table)).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
)
