import { StructuredAgentSessionAdapterRouter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-router'
import type { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/providers/structured-agent-registry'
import type { CodemodeService } from '../../../codemode/codemode-service'

type AcquireInput = Parameters<StructuredAgentSessionAdapterRouter['acquire']>[0]

/** The router, telling code mode which child each attempt's launch spawned; a failed attempt ends its own. */
export class CodemodeAcquisitionRouter extends StructuredAgentSessionAdapterRouter {
  constructor(
    agents: StructuredAgentRegistry,
    closeAdapters: () => Promise<void>,
    private readonly codemode: Pick<CodemodeService, 'bindChild' | 'endSession'>
  ) {
    super(agents, closeAdapters)
  }

  override async acquire(
    input: AcquireInput
  ): ReturnType<StructuredAgentSessionAdapterRouter['acquire']> {
    const { sessionId } = input.identity
    try {
      const acquired = await super.acquire(input)
      if (input.attemptId) {
        this.codemode.bindChild(sessionId, input.attemptId, acquired.acquisitionGeneration)
      }
      return acquired
    } catch (error) {
      if (input.attemptId) {
        void this.codemode.endSession(sessionId, input.attemptId)
      }
      throw error
    }
  }
}
