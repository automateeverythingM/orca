import { defineStreamingMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { SubscribeCodemodeRunsParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-subscribe-params'
import { CODEMODE_RUNS_SUBSCRIBE_METHOD } from '../../../../../../shared/codemode/codemode-run-wire'
import { processCodemodeRunStore } from '../../../../../codemode/runs/codemode-run-store'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { structuredAgentSessionCodemodeRunsSubscriptionId } from './structured-agent-session-subscription-id'

// Runs live on the host that launched the session, so a remote chat's runs come over its runtime.
export const STRUCTURED_AGENT_SESSION_CODEMODE_RUN_METHODS = [
  defineStreamingMethod({
    name: CODEMODE_RUNS_SUBSCRIBE_METHOD,
    permission: 'workspace',
    params: SubscribeCodemodeRunsParams,
    handler: async (params, ctx, emit) => {
      await requireInstalledStructuredHost(ctx, params.sessionId)
      const subscriptionId = structuredAgentSessionCodemodeRunsSubscriptionId(ctx, params.sessionId)
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = processCodemodeRunStore().subscribe(params.sessionId, emit)
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]
