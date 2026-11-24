import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { createOrcaRpcAccess } from './codemode-orca-dispatch'
import { codemodeOrcaRuntimeRpc } from './codemode-orca-runtime-wiring'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('codemodeOrcaRuntimeRpc', () => {
  it("exposes Orca's registry and dispatches through a real dispatcher as the chat", async () => {
    const dispatched = vi.spyOn(RpcDispatcher.prototype, 'dispatch')
    const rpc = codemodeOrcaRuntimeRpc(new OrcaRuntimeService(null))
    const access = createOrcaRpcAccess({ ...rpc, sessionId: 's1', root: '/repo' })

    const areas = access.index().areas()
    expect(areas).toContain('worktree')
    expect(areas).not.toContain('codemode')
    expect(dispatched).not.toHaveBeenCalled()

    const name = 'worktree.list'
    const outcome = await access.call(name, {}, new AbortController().signal)

    // A runtime with no repos lists none: the real handler answered through the real dispatcher.
    expect(outcome).toMatchObject({ worktrees: [], totalCount: 0 })
    expect(dispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        method: name,
        orchestrationCompatibilityEvidence: { agentSessionId: 's1' }
      }),
      expect.objectContaining({ caller: { kind: 'local-cli' } })
    )
  })
})
