import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type CodemodeServerSpec = {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  source: 'orca' | 'project'
}

const SOURCES: { file: readonly string[]; source: CodemodeServerSpec['source'] }[] = [
  { file: ['.orca', 'mcp.json'], source: 'orca' },
  { file: ['.mcp.json'], source: 'project' }
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toSpec(
  name: string,
  entry: unknown,
  source: CodemodeServerSpec['source']
): CodemodeServerSpec | null {
  if (!isRecord(entry) || typeof entry.command !== 'string' || entry.command === '') {
    return null
  }
  if (entry.disabled === true || entry.enabled === false) {
    return null
  }
  const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : []
  const spec: CodemodeServerSpec = { name, command: entry.command, args, source }
  if (isRecord(entry.env)) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value === 'string') {
        env[key] = value
      }
    }
    spec.env = env
  }
  return spec
}

export async function readCodemodeServerSpecs(
  dir: string
): Promise<{ specs: CodemodeServerSpec[]; problems: string[] }> {
  const specs: CodemodeServerSpec[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const { file, source } of SOURCES) {
    const path = join(dir, ...file)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      problems.push(
        `${path}: invalid JSON (${error instanceof Error ? error.message : 'parse error'})`
      )
      continue
    }
    const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {}
    for (const [name, entry] of Object.entries(servers)) {
      if (seen.has(name)) {
        continue
      }
      const spec = toSpec(name, entry, source)
      if (spec) {
        seen.add(name)
        specs.push(spec)
      }
    }
  }
  return { specs, problems }
}
