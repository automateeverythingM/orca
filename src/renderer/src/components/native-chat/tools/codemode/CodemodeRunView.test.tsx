// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CodemodeRunRecord } from '../../../../../../shared/codemode/codemode-run-wire'
import type { NativeChatToolCallBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from '../../media/visuals/native-chat-visual-owner'
import { CodemodeRunView } from './CodemodeRunView'
import * as learnClient from '../../../settings/codemode/codemode-learn-client'

vi.mock('../../../settings/codemode/codemode-learn-client', async (importActual) => ({
  ...(await importActual<typeof learnClient>()),
  proposeCodemodeLearn: vi.fn(async () => ({ started: true }))
}))

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
const run = (seenInChats?: number, shape?: string): CodemodeRunRecord => ({
  runId: 'r1',
  code: CODE,
  state: 'ok',
  startedAt: 1,
  omittedCalls: 0,
  calls: [],
  ms: 3,
  ...(seenInChats === undefined ? {} : { seenInChats }),
  ...(shape === undefined ? {} : { shape })
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

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

it('Learn from this asks Learn about this chat and script', async () => {
  await show(run(3, 'shape-1'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Learn from this' }))
  })
  expect(learnClient.proposeCodemodeLearn).toHaveBeenCalledWith({
    sessionId: 's1',
    shape: 'shape-1'
  })
  expect(screen.getByText('Learning… see Settings › Code mode › Learn')).toBeTruthy()
})

it('Learn from this says why a run did not start', async () => {
  vi.mocked(learnClient.proposeCodemodeLearn).mockResolvedValueOnce({
    started: false,
    code: 'off',
    reason: 'Learn is off'
  })
  await show(run(3, 'shape-1'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Learn from this' }))
  })
  expect(screen.getByRole('alert').textContent).toBe('Learn is off')
})

it('no Learn from this without a shape', async () => {
  await show(run(3))
  expect(screen.queryByRole('button', { name: 'Learn from this' })).toBeNull()
})
