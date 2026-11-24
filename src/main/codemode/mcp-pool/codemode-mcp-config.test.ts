import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCodemodeServerSpecs } from './codemode-mcp-config'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-mcp-config-'))
  mkdirSync(join(dir, '.orca'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (file: string, body: unknown) =>
  writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body))

describe('readCodemodeServerSpecs', () => {
  it('prefers .orca/mcp.json over .mcp.json and keeps only enabled stdio entries', async () => {
    write('.orca/mcp.json', {
      mcpServers: {
        crm: { command: 'node', args: ['a.js'], env: { K: 'v' } },
        off: { command: 'node', disabled: true },
        off2: { command: 'node', enabled: false }
      }
    })
    write('.mcp.json', {
      mcpServers: {
        crm: { command: 'other' },
        remote: { type: 'http', url: 'https://x.test' },
        docs: { command: 'docs-server' }
      }
    })
    const { specs, problems } = await readCodemodeServerSpecs(dir)
    expect(problems).toEqual([])
    expect(specs).toEqual([
      { name: 'crm', command: 'node', args: ['a.js'], env: { K: 'v' }, source: 'orca' },
      { name: 'docs', command: 'docs-server', args: [], source: 'project' }
    ])
  })

  it('reports invalid JSON and still reads the other file', async () => {
    write('.orca/mcp.json', '{ nope')
    write('.mcp.json', { mcpServers: { docs: { command: 'd' } } })
    const { specs, problems } = await readCodemodeServerSpecs(dir)
    expect(specs.map((s) => s.name)).toEqual(['docs'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('mcp.json')
  })

  it('returns nothing when neither file exists', async () => {
    rmSync(join(dir, '.orca'), { recursive: true })
    expect(await readCodemodeServerSpecs(dir)).toEqual({ specs: [], problems: [] })
  })
})
