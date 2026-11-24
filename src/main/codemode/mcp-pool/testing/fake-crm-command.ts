import { build } from 'esbuild'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

let bundled: Promise<string> | null = null

async function buildFixture(): Promise<string> {
  const cacheRoot = resolve('node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  const outDir = await mkdtemp(join(cacheRoot, 'orca-fake-crm-'))
  const outfile = join(outDir, 'fake-crm-mcp-server.cjs')
  await build({
    entryPoints: [resolve('src/main/codemode/mcp-pool/testing/fake-crm-mcp-server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  return outfile
}

/** Builds the fake CRM stdio MCP server once per process and returns a spawnable command. */
export async function fakeCrmServerSpec(): Promise<{ command: string; args: string[] }> {
  bundled ??= buildFixture()
  return { command: process.execPath, args: [await bundled] }
}
