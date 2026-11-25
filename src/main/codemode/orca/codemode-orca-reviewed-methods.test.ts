import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { OrcaMethodIndex } from './codemode-orca-method-index'
import { orcaMethodArea, type OrcaMethodLabel } from './codemode-orca-method-policy'
import {
  CODEMODE_ORCA_REVIEWED_FILES,
  CODEMODE_ORCA_REVIEWED_METHODS
} from './codemode-orca-reviewed-methods'

// Prints the whole current table, file by file, to paste after review:
// CODEMODE_ORCA_PRINT_TABLE=1 pnpm test src/main/codemode/orca/codemode-orca-reviewed-methods.test.ts \
//   -t prints --disableConsoleIntercept
const PRINT_TABLE = process.env.CODEMODE_ORCA_PRINT_TABLE === '1'

const index = OrcaMethodIndex.from(ALL_RPC_METHODS)
const current = new Map<string, OrcaMethodLabel>(
  index
    .areas()
    .flatMap((area) => index.inArea(area))
    .map((entry) => [entry.name, entry.label])
)
const reviewed = new Map<string, OrcaMethodLabel>(Object.entries(CODEMODE_ORCA_REVIEWED_METHODS))

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const line = (name: string, label: OrcaMethodLabel | undefined): string => `'${name}': '${label}',`

/** The data file that holds a method, else one holding its area, else the last file. */
function fileFor(name: string): string {
  const files = CODEMODE_ORCA_REVIEWED_FILES
  const holder =
    files.find(({ table }) => Object.hasOwn(table, name)) ??
    files.find(({ table }) =>
      Object.keys(table).some((key) => orcaMethodArea(key) === orcaMethodArea(name))
    ) ??
    files.at(-1)
  return holder?.file ?? 'reviewed/'
}

describe('reviewed orca.* methods', () => {
  it('pins every exposed method with the label it gets', () => {
    const problems: string[] = []
    for (const [name, label] of current) {
      const was = reviewed.get(name)
      if (was === undefined) {
        problems.push(`add to ${fileFor(name)}: ${line(name, label)}`)
      } else if (was !== label) {
        problems.push(`change in ${fileFor(name)}: ${line(name, was)} -> ${line(name, label)}`)
      }
    }
    for (const [name, label] of reviewed) {
      if (!current.has(name)) {
        problems.push(`remove from ${fileFor(name)}: ${line(name, label)}`)
      }
    }
    const advice =
      'orca.* exposure changed. Review each method (deny or relabel it in the policy or ' +
      'labels file if needed), then edit the tables:'
    expect(problems, `${advice}\n${problems.join('\n')}`).toEqual([])
  })

  it('keeps each data file sorted by name and free of names another file holds', () => {
    const seen = new Set<string>()
    for (const { file, table } of CODEMODE_ORCA_REVIEWED_FILES) {
      const names = Object.keys(table)
      expect(names, file).toEqual([...names].sort(byName))
      expect(
        names.filter((name) => seen.has(name)),
        file
      ).toEqual([])
      names.forEach((name) => seen.add(name))
    }
  })

  it.runIf(PRINT_TABLE)('prints the current table, file by file', () => {
    for (const { file } of CODEMODE_ORCA_REVIEWED_FILES) {
      const lines = [...current]
        .filter(([name]) => fileFor(name) === file)
        .sort(([a], [b]) => byName(a, b))
        .map(([name, label]) => `  ${line(name, label)}`)
      console.log(`// ${file}\n${lines.join('\n')}`)
    }
  })
})
