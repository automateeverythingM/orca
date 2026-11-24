import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { OWNER_RPC_CALLER_SCOPE } from '../../runtime/rpc/callers/rpc-caller-scope'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { setProcessCodemodeOrcaRpc } from '../codemode-process-service'
import type { CodemodeOrcaRpc } from '../codemode-service-types'

/**
 * Every registered method over an in-process dispatcher on `runtime`, as the owner. The method
 * index decides what scripts see; the dispatcher is built on the first call, so startup pays nothing.
 */
export function codemodeOrcaRuntimeRpc(runtime: OrcaRuntimeService): CodemodeOrcaRpc {
  let dispatcher: RpcDispatcher | undefined
  return {
    methods: ALL_RPC_METHODS,
    dispatch: (request, options) => {
      dispatcher ??= new RpcDispatcher({
        runtime,
        methods: ALL_RPC_METHODS,
        callerScope: OWNER_RPC_CALLER_SCOPE
      })
      return dispatcher.dispatch(request, options)
    }
  }
}

/** Gives code-mode chats `orca.*` over this process's runtime; called where the runtime is composed. */
export function connectCodemodeToOrcaRuntime(runtime: OrcaRuntimeService): void {
  setProcessCodemodeOrcaRpc(codemodeOrcaRuntimeRpc(runtime))
}
