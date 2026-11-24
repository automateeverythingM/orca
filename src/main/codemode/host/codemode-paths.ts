import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

async function realpathOfDeepestAncestor(target: string): Promise<string> {
  const tail: string[] = []
  let current = target
  for (;;) {
    try {
      return join(await realpath(current), ...tail.toReversed())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = dirname(current)
      // ENOENT/ENOTDIR mean this component does not exist yet; any other error (EACCES, ELOOP) fails closed.
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) {
        throw error
      }
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
      current = parent
    }
  }
}

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (isAbsolute(rel)) {
    return false
  }
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Resolve `input` against `root`, following symlinks of the deepest existing ancestor. */
export async function resolveInRoot(
  root: string,
  input: string
): Promise<{ path: string; inside: boolean }> {
  const realRoot = await realpath(root)
  const lexical = resolve(realRoot, input)
  let path: string
  try {
    path = await realpathOfDeepestAncestor(lexical)
  } catch {
    return { path: lexical, inside: false }
  }
  return { path, inside: isPathInside(realRoot, path) }
}
