// Checks that a proposal's source only defines its function. The writer's body is pasted into
// `async function <name>(…) {…}`, so a body could close it early and add code that runs whenever the
// file loads. The source is evaluated alone in QuickJS with a host that answers nothing.
import type { CodemodeLimits } from '../../codemode-limits'
import { hostCallLabel } from '../../host/codemode-host-dispatch'
import type { ScriptHost } from '../../sandbox/codemode-host-tools'
import { runScriptInWorker } from '../../sandbox/codemode-worker-run'

export const structureFailureText = (name: string): string =>
  `source must define only the function ${name}`

/**
 * Evaluates the source as a global script and reports whether the only global it added is `name`,
 * holding a function. Built-ins are captured first, so the source cannot fake the answer; a global
 * script also refuses a top-level `return`, which the lib loader's wrapper would accept.
 */
function structureScript(source: string, name: string): string {
  const key = JSON.stringify(name)
  return [
    'const g = globalThis',
    'const ev = eval',
    'const own = Object.getOwnPropertyNames',
    'const describe = Object.getOwnPropertyDescriptor',
    'const hasOwn = Object.hasOwn',
    'const seen = Object.create(null)',
    // A name that is already a sandbox global (read, print…) must be defined again by the source.
    `delete g[${key}]`,
    'const before = own(g)',
    'for (let i = 0; i < before.length; i++) seen[before[i]] = true',
    `ev(${JSON.stringify(source)})`,
    'const after = own(g)',
    'let extra = 0',
    `for (let i = 0; i < after.length; i++) if (seen[after[i]] !== true && after[i] !== ${key}) extra++`,
    `const d = describe(g, ${key})`,
    "return extra === 0 && d !== undefined && hasOwn(d, 'value') && typeof d.value === 'function'"
  ].join('\n')
}

export type StructureCheck = { ok: true } | { ok: false; detail: string }

export async function checkSourceStructure(
  source: string,
  name: string,
  deps: { workerPath?: string; limits: CodemodeLimits; signal: AbortSignal }
): Promise<StructureCheck> {
  const called: string[] = []
  const host: ScriptHost = async (call) => {
    called.push(hostCallLabel(call).tool)
    return { ok: false, error: 'no calls while loading a function file' }
  }
  const result = await runScriptInWorker(
    structureScript(source, name),
    host,
    deps.limits,
    deps.signal,
    deps.workerPath
  )
  if (called.length > 0) {
    return { ok: false, detail: `loading the source called ${called.join(', ')}` }
  }
  if (!result.ok) {
    return { ok: false, detail: `loading the source failed: ${result.error}` }
  }
  if (result.value !== true) {
    return { ok: false, detail: 'loading the source defined other globals or no function' }
  }
  return { ok: true }
}
