// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { CodemodeRunRecord } from '../../../../../../shared/codemode/codemode-run-wire'
import type { NativeChatToolCallBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from '../../media/visuals/native-chat-visual-owner'
import { CodemodeRunView } from './CodemodeRunView'

const CODE = 'return 1'
const OWNER: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 's1',
  worktreeId: 'w1'
}
const block: NativeChatToolCallBlock = {
  type: 'tool-call',
  name: 'mcp__orca__run_js',
  input: { code: CODE },
  callId: 'toolu_01',
  state: 'completed'
}
const run = (seenInChats?: number): CodemodeRunRecord => ({
  runId: 'r1',
  code: CODE,
  state: 'ok',
  startedAt: 1,
  omittedCalls: 0,
  calls: [],
  ms: 3,
  ...(seenInChats === undefined ? {} : { seenInChats })
})

async function show(record: CodemodeRunRecord): Promise<void> {
  render(
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      <CodemodeRunView block={block} result={undefined} run={record} />
    </NativeChatVisualOwnerContext.Provider>
  )
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button')[0] ?? document.body)
  })
}

afterEach(cleanup)

it('says how many chats ran the script, next to Save as function', async () => {
  await show(run(3))
  expect(screen.getByText('Save as function')).toBeTruthy()
  expect(screen.getByText('Ran in 3 chats')).toBeTruthy()
})

it('says nothing for a script seen in one chat or not counted', async () => {
  await show(run(1))
  expect(screen.queryByText(/^Ran in/)).toBeNull()
  cleanup()
  await show(run())
  expect(screen.queryByText(/^Ran in/)).toBeNull()
})
