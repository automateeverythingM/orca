import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { type CodemodeLibAccess, libSignatures } from './codemode-lib-host-plan'
import { CodemodeLibStore } from './codemode-lib-store'
import { CodemodeLibTrust } from './codemode-lib-trust'
import { CodemodeLibUsage } from './codemode-lib-usage'

/** The trust and usage records every chat shares; one instance each, so their writes queue together. */
export type CodemodeLibRecords = {
  trust: CodemodeLibTrust
  usage: CodemodeLibUsage
  /** Home for global functions; default the user's home. */
  homeDir?: string
}

export function createLibRecords(homeDir?: string): CodemodeLibRecords {
  return {
    trust: new CodemodeLibTrust({ homeDir }),
    usage: new CodemodeLibUsage({ homeDir }),
    ...(homeDir ? { homeDir } : {})
  }
}

function realOrResolved(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

/**
 * A chat's saved functions: project scope at its root, global in the records' home. A chat rooted
 * at the home dir has no project scope, so `~/.orca/lib` is never both scopes.
 */
export async function libAccessFor(
  root: string,
  records: CodemodeLibRecords
): Promise<CodemodeLibAccess> {
  const [realRoot, realHome] = await Promise.all([
    realOrResolved(root),
    realOrResolved(records.homeDir ?? homedir())
  ])
  const projectRoot = realRoot === realHome ? null : root
  return {
    store: new CodemodeLibStore({ projectRoot, homeDir: records.homeDir }),
    trust: records.trust,
    usage: records.usage,
    projectRoot
  }
}

/** A launching chat's access and its signatures for the description; a read failure logs and gives none. */
export async function openChatLib(
  root: string,
  records: CodemodeLibRecords,
  log: (message: string, error?: unknown) => void
): Promise<{ lib: CodemodeLibAccess; signatures: string[] }> {
  const lib = await libAccessFor(root, records)
  const signatures = await libSignatures(lib.store).catch((error: unknown) => {
    log('saved functions could not be read', error)
    return []
  })
  return { lib, signatures }
}
