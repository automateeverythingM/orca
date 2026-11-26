// Tests only: the real QuickJS worker entry, bundled once per test file, for replay tests.
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Bundles the worker; `dispose` removes the bundle. */
export async function bundleTestWorker(): Promise<{
  workerPath: string
  dispose: () => Promise<void>
}> {
  // The QuickJS variant locates its WASM beside itself, so the bundle stays external and resolves from the repo.
  const cacheRoot = resolve('node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  const bundleRoot = await mkdtemp(join(cacheRoot, 'orca-codemode-learn-'))
  const workerPath = join(bundleRoot, 'codemode-worker-entry.js')
  await build({
    entryPoints: [resolve('src/main/codemode/sandbox/codemode-worker-entry.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'],
    logLevel: 'silent'
  })
  return { workerPath, dispose: () => rm(bundleRoot, { recursive: true, force: true }) }
}
