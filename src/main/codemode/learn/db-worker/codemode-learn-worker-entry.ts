// The Learn DB worker: the Learn store's SQL runs here, off Electron main. One request at a time (the
// client serializes them), each answered by one store call.
import { parentPort } from 'node:worker_threads'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import { callLearnOp, isCodemodeLearnOp } from '../store/codemode-learn-ops'
import { CodemodeLearnStore } from '../store/codemode-learn-store'
import type {
  CodemodeLearnWorkerRequest,
  CodemodeLearnWorkerResponse
} from './codemode-learn-worker-protocol'

installWorkerSendLedger('orca-codemode-learn')

const opened = new Map<string, CodemodeLearnStore>()

function storeFor(path: string): CodemodeLearnStore {
  let store = opened.get(path)
  if (!store) {
    store = CodemodeLearnStore.open(path)
    opened.set(path, store)
  }
  return store
}

function handleCodemodeLearnRequest(
  request: CodemodeLearnWorkerRequest
): CodemodeLearnWorkerResponse {
  try {
    if (!isCodemodeLearnOp(request.op)) {
      throw new Error(`The Learn DB worker has no ${request.op}.`)
    }
    const value = callLearnOp(storeFor(request.path), request.op, request.args)
    return { id: request.id, ok: true, value }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Closes every open file; the next request reopens. */
function closeCodemodeLearnStores(): void {
  for (const store of opened.values()) {
    store.dispose()
  }
  opened.clear()
}

const port = parentPort
if (port) {
  port.on('message', (request: CodemodeLearnWorkerRequest) => {
    port.postMessage(handleCodemodeLearnRequest(request))
  })
  port.on('close', closeCodemodeLearnStores)
}
