import { CodemodeService } from './codemode-service'
import type {
  CodemodeConnectorWiring,
  CodemodeOrcaRpc,
  CodemodeServiceOptions
} from './codemode-service-types'
import { CodemodeConnectorAuth } from './connectors/codemode-connector-auth'
import { CodemodeConnectorPool } from './connectors/codemode-connector-pool'
import { CodemodeConnectorStore } from './connectors/codemode-connector-store'

let processService: CodemodeService | null = null
let processOrcaRpc: CodemodeOrcaRpc | undefined

async function openDefaultConnectors(): Promise<CodemodeConnectorWiring> {
  const store = await CodemodeConnectorStore.open()
  const auth = new CodemodeConnectorAuth(store)
  return { store, auth, pool: new CodemodeConnectorPool(store, auth) }
}

/** The process's service once the runtime created it; null before. */
export const installedCodemodeService = (): CodemodeService | null => processService

/** The process's one service, with the user's connector list; the first caller's options win. */
export function processCodemodeService(opts?: CodemodeServiceOptions): CodemodeService {
  return (processService ??= new CodemodeService({
    connectors: openDefaultConnectors,
    ...(processOrcaRpc ? { orcaRpc: processOrcaRpc } : {}),
    ...opts
  }))
}

/** Orca's runtime for the process's service, whether or not a chat has created it yet. */
export function setProcessCodemodeOrcaRpc(orcaRpc: CodemodeOrcaRpc): void {
  processOrcaRpc = orcaRpc
  processService?.setOrcaRpc(orcaRpc)
}
