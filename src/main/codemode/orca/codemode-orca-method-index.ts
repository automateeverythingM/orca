import type { ZodType } from 'zod'
import { labelOrcaMethod } from './codemode-orca-method-labels'
import {
  isExposedOrcaMethod,
  orcaMethodArea,
  type OrcaMethodLabel,
  type OrcaMethodSource
} from './codemode-orca-method-policy'

export type OrcaMethodEntry = {
  name: string
  area: string
  label: OrcaMethodLabel
  params: ZodType | null
}

/** The runtime RPC methods a code-mode script may call as `orca.<area>.<method>`, by area. */
export class OrcaMethodIndex {
  private readonly byName: ReadonlyMap<string, OrcaMethodEntry>
  private readonly byArea: ReadonlyMap<string, readonly OrcaMethodEntry[]>

  private constructor(entries: readonly OrcaMethodEntry[]) {
    this.byName = new Map(entries.map((entry) => [entry.name, entry]))
    const byArea = new Map<string, OrcaMethodEntry[]>()
    for (const entry of entries) {
      const list = byArea.get(entry.area) ?? []
      list.push(entry)
      byArea.set(entry.area, list)
    }
    for (const list of byArea.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name))
    }
    this.byArea = byArea
  }

  static from(methods: readonly OrcaMethodSource[]): OrcaMethodIndex {
    const entries: OrcaMethodEntry[] = []
    for (const method of methods) {
      if (isExposedOrcaMethod(method)) {
        entries.push({
          name: method.name,
          area: orcaMethodArea(method.name),
          label: labelOrcaMethod(method.name),
          params: method.params
        })
      }
    }
    return new OrcaMethodIndex(entries)
  }

  areas(): string[] {
    return [...this.byArea.keys()].sort()
  }

  inArea(area: string): OrcaMethodEntry[] {
    return [...(this.byArea.get(area) ?? [])]
  }

  get(name: string): OrcaMethodEntry | null {
    return this.byName.get(name) ?? null
  }
}
