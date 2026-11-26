import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type {
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../../../shared/native-chat/native-chat-types'
import type {
  CodemodeInnerCallRecord,
  CodemodeRunRecord
} from '../../../../../../shared/codemode/codemode-run-wire'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from '../../media/visuals/native-chat-visual-owner'
import { CodemodeRunView } from './CodemodeRunView'

const owner: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'fixture-session',
  worktreeId: 'fixture-worktree'
}

const CODE = `const user = JSON.parse(await mcp['fake-crm'].find_user({ email: 'dana@example.com' }))
await mcp['fake-crm'].add_to_group({ user_id: user.id, group: 'beta' })
return JSON.parse(await mcp['fake-crm'].add_credits({ user_id: user.id, amount: 120 }))`

const block: NativeChatToolCallBlock = {
  type: 'tool-call',
  name: 'mcp__orca__run_js',
  input: { code: CODE },
  callId: 'toolu_01'
}

const call = (
  seq: number,
  tool: string,
  state: CodemodeInnerCallRecord['state'],
  fields: Partial<CodemodeInnerCallRecord> = {}
): CodemodeInnerCallRecord => ({
  seq,
  tool,
  input: JSON.stringify({ user_id: 'u1', amount: 120 }, null, 2),
  state,
  ...fields
})

const run = (
  state: CodemodeRunRecord['state'],
  calls: CodemodeInnerCallRecord[],
  ms?: number
): CodemodeRunRecord => ({
  runId: 'r1',
  code: CODE,
  state,
  startedAt: 1_763_400_000_000,
  omittedCalls: 0,
  calls,
  ...(ms === undefined ? {} : { ms })
})

const Frame = ({
  state,
  result,
  record
}: {
  state: NativeChatToolCallBlock['state']
  result?: NativeChatToolResultBlock
  record: CodemodeRunRecord
}) => (
  <div className="native-chat-appearance bg-chat-canvas p-4">
    <NativeChatVisualOwnerContext.Provider value={owner}>
      <CodemodeRunView block={{ ...block, state }} result={result} run={record} />
    </NativeChatVisualOwnerContext.Provider>
  </div>
)

export const running = defineFixture({
  width: 560,
  render: () => (
    <Frame
      state="running"
      record={run('running', [
        call(1, 'mcp.fake-crm.find_user', 'ok', { ms: 84, output: '{"id":"u1"}' }),
        call(2, 'mcp.fake-crm.add_to_group', 'ok', { ms: 41, output: 'ok' }),
        call(3, 'mcp.fake-crm.add_credits', 'running')
      ])}
    />
  )
})

export const finished = defineFixture({
  width: 560,
  render: () => (
    <Frame
      state="completed"
      result={{ type: 'tool-result', output: '=> {"id":"u1","credits":120}', callId: 'toolu_01' }}
      record={run(
        'ok',
        [
          call(1, 'mcp.fake-crm.find_user', 'ok', { ms: 84, output: '{"id":"u1"}' }),
          call(2, 'mcp.fake-crm.add_to_group', 'ok', { ms: 41, output: 'ok' }),
          call(3, 'mcp.fake-crm.add_credits', 'ok', { ms: 120, output: '{"credits":120}' })
        ],
        312
      )}
    />
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
  }
})

export const failed = defineFixture({
  width: 560,
  render: () => (
    <Frame
      state="failed"
      result={{
        type: 'tool-result',
        output: 'Error: user u1 has no billing account',
        isError: true,
        callId: 'toolu_01'
      }}
      record={run(
        'error',
        [
          call(1, 'mcp.fake-crm.find_user', 'ok', { ms: 84, output: '{"id":"u1"}' }),
          call(2, 'mcp.fake-crm.add_to_group', 'ok', { ms: 41, output: 'ok' }),
          call(3, 'mcp.fake-crm.add_credits', 'error', {
            ms: 1260,
            output: 'user u1 has no billing account'
          })
        ],
        1402
      )}
    />
  ),
  interact: (frame) => {
    frame.querySelectorAll<HTMLButtonElement>('li button')[2]?.click()
  }
})

export const seenInOtherChats = defineFixture({
  width: 560,
  render: () => (
    <Frame
      state="completed"
      result={{ type: 'tool-result', output: '=> {"id":"u1","credits":120}', callId: 'toolu_01' }}
      record={{
        ...run(
          'ok',
          [
            call(1, 'mcp.fake-crm.find_user', 'ok', { ms: 84, output: '{"id":"u1"}' }),
            call(2, 'mcp.fake-crm.add_credits', 'ok', { ms: 120, output: '{"credits":120}' })
          ],
          240
        ),
        seenInChats: 3,
        shape: 'a'.repeat(64)
      }}
    />
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
  }
})
