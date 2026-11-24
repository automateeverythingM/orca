import { parentPort, workerData } from 'node:worker_threads'
import { runScript, type HostCall, type HostReply } from './codemode-script-runner'
import type { CodemodeWorkerInput, CodemodeWorkerMessage } from './codemode-worker-protocol'

const port = parentPort
if (port) {
  const { code, limits }: CodemodeWorkerInput = workerData
  const waiting = new Map<number, (reply: HostReply) => void>()
  let nextId = 0

  port.on('message', (message: CodemodeWorkerMessage) => {
    if (message.type === 'reply') {
      waiting.get(message.id)?.(message.reply)
      waiting.delete(message.id)
    }
  })

  const host = (call: HostCall): Promise<HostReply> =>
    new Promise((resolve) => {
      const id = nextId++
      waiting.set(id, resolve)
      port.postMessage({ type: 'call', id, call } satisfies CodemodeWorkerMessage)
    })

  // Abort is handled by the parent terminating this thread; an in-thread signal cannot stop a pure CPU loop.
  void runScript(code, host, limits, new AbortController().signal).then((result) => {
    port.postMessage({ type: 'done', result } satisfies CodemodeWorkerMessage)
    port.close()
  })
}
