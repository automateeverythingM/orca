import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  codemodeRunForCall,
  codemodeRunsKey,
  codemodeRunsVersion,
  retainCodemodeRuns,
  watchCodemodeCall
} from '@/runtime/native-chat/requests/codemode-run-subscriptions'
import type { CodemodeRunRecord } from '../../../../../../shared/codemode/codemode-run-wire'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import type { CodemodeRunCall } from './codemode-run-rows'

const NO_SUBSCRIPTION = (): (() => void) => () => {}

/** The run the session's host reports for this run_js call; null outside a structured chat. */
export function useCodemodeRun(call: CodemodeRunCall): CodemodeRunRecord | null {
  const owner = useNativeChatVisualOwner()
  const target = owner?.target ?? null
  const sessionId = owner?.sessionId ?? null
  const key = target && sessionId ? codemodeRunsKey(target, sessionId) : null
  const subscribe = useCallback(
    (onChange: () => void) =>
      target && sessionId ? retainCodemodeRuns(target, sessionId, onChange) : NO_SUBSCRIPTION(),
    [target, sessionId]
  )
  useSyncExternalStore(subscribe, () => (key ? codemodeRunsVersion(key) : 0))
  const { callId, code, running } = call
  useEffect(
    () =>
      target && sessionId
        ? watchCodemodeCall(target, sessionId, { callId, code, running })
        : undefined,
    [target, sessionId, callId, code, running]
  )
  return key ? codemodeRunForCall(key, callId) : null
}
