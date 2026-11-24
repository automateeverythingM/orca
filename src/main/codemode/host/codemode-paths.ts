import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'

const MAX_LINK_HOPS = 40

/** Resolve a missing path by following dangling symlinks, so a link cannot hide an outside target. */
async function realpathOfDeepestAncestor(target: string): Promise<string> {
  let hops = 0
  let pending = target
  for (;;) {
    const tail: string[] = []
    let current = pending
    let redirected: string | null = null
    for (;;) {
      try {
        return join(await realpath(current), ...tail.toReversed())
      } catch (error) {
        const code = errnoCodeOrUnknown(error)
        const parent = dirname(current)
        // ENOENT/ENOTDIR mean this component is missing or dangling; any other error (EACCES, ELOOP) fails closed.
        if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) {
          throw error
        }
        let isLink = false
        try {
          isLink = (await lstat(current)).isSymbolicLink()
        } catch {
          /* missing component */
        }
        if (isLink) {
          redirected = join(resolve(parent, await readlink(current)), ...tail.toReversed())
          break
        }
        tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
        current = parent
      }
    }
    if (++hops > MAX_LINK_HOPS) {
      throw new Error('too many symbolic links')
    }
    pending = redirected
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
