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
 * Evaluates the source as a global script and reports whether the only change to the globals is a
 * new `name` holding a function: no other new key (string or symbol) and no global replaced or
 * removed. Built-ins are captured first, so the source cannot fake the answer; a global script also
 * refuses a top-level `return`, which the lib loader's wrapper would accept.
 */
function structureScript(source: string, name: string): string {
  const key = JSON.stringify(name)
  return [
    'const g = globalThis',
    'const ev = eval',
    'const ownKeys = Reflect.ownKeys',
    'const describe = Object.getOwnPropertyDescriptor',
    'const hasOwn = Object.hasOwn',
    'const same = Object.is',
    // A name that is already a sandbox global (read, print…) must be defined again by the source.
    `delete g[${key}]`,
    'const before = ownKeys(g)',
    'const was = []',
    'for (let i = 0; i < before.length; i++) was[i] = describe(g, before[i])',
    'const kept = (a, b) =>',
    '  b !== undefined &&',
    "  (hasOwn(a, 'value')",
    "    ? hasOwn(b, 'value') && same(a.value, b.value)",
    "    : hasOwn(b, 'get') && same(a.get, b.get) && same(a.set, b.set))",
    `ev(${JSON.stringify(source)})`,
    'for (let i = 0; i < before.length; i++) if (!kept(was[i], describe(g, before[i]))) return false',
    'const after = ownKeys(g)',
    'for (let i = 0; i < after.length; i++) {',
    `  if (after[i] === ${key}) continue`,
    '  let found = false',
    '  for (let j = 0; j < before.length && !found; j++) found = before[j] === after[i]',
    '  if (!found) return false',
    '}',
    `const d = describe(g, ${key})`,
    "return d !== undefined && hasOwn(d, 'value') && typeof d.value === 'function'"
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
    return { ok: false, detail: 'loading the source changed other globals or defined no function' }
  }
  return { ok: true }
}
