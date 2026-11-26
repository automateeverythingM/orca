import type { NativeChatCodeBlockRunStatus } from '../../../../../../shared/native-chat/code-block-run/native-chat-code-block-run-types'
import { appendBoundedCodeBlockOutput } from '../../../../../../shared/native-chat/code-block-run/native-chat-code-block-output'
import {
  extractCodeBlockRunErrorMessage,
  type NativeChatCodeBlockRunTransport
} from './native-chat-code-run-transport'

export type NativeChatCodeBlockRunRecord = {
  runId: number
  status: NativeChatCodeBlockRunStatus
  output: string
  truncated: boolean
  exitCode: number | null
  signal: string | null
  startedAt: number
  durationMs: number | null
  cwd?: string
  error?: string
}

export type NativeChatCodeBlockRunStartArgs = {
  blockKey: string
  command: string
  language?: string
}

export type NativeChatCodeBlockRunStore = {
  subscribe: (blockKey: string, listener: () => void) => () => void
  getSnapshot: (blockKey: string) => NativeChatCodeBlockRunRecord | undefined
  run: (args: NativeChatCodeBlockRunStartArgs) => void
  stop: (blockKey: string) => void
  clear: (blockKey: string) => void
  dispose: () => void
}

const MAX_RETAINED_RUNS = 64

/** Keeps inline shell run output & active streams outside virtualized transcript rows. */
export function createNativeChatCodeBlockRunStore(
  transport: NativeChatCodeBlockRunTransport,
  initialRecords?: ReadonlyMap<string, NativeChatCodeBlockRunRecord>
): NativeChatCodeBlockRunStore {
  const records = new Map<string, NativeChatCodeBlockRunRecord>(initialRecords)
  const activeSubscriptions = new Map<string, { runId: number; unsubscribe: () => void }>()
  const listenersByKey = new Map<string, Set<() => void>>()
  let nextRunId = 1
  let disposed = false

  const notify = (blockKey: string): void => {
    const listeners = listenersByKey.get(blockKey)
    if (!listeners) {
      return
    }
    for (const listener of listeners) {
      listener()
    }
  }

  const setRecord = (blockKey: string, record: NativeChatCodeBlockRunRecord): void => {
    records.delete(blockKey)
    records.set(blockKey, record)
    if (records.size > MAX_RETAINED_RUNS) {
      for (const candidateKey of records.keys()) {
        if (candidateKey !== blockKey && !activeSubscriptions.has(candidateKey)) {
          records.delete(candidateKey)
          break
        }
      }
    }
    notify(blockKey)
  }

  const cancelActive = (blockKey: string): void => {
    const active = activeSubscriptions.get(blockKey)
    if (!active) {
      return
    }
    activeSubscriptions.delete(blockKey)
    try {
      active.unsubscribe()
    } catch {
      /* already closed */
    }
  }

  const run = ({ blockKey, command, language }: NativeChatCodeBlockRunStartArgs): void => {
    if (disposed) {
      return
    }
    cancelActive(blockKey)
    const runId = nextRunId++
    const startedAt = Date.now()
    let settled = false

    setRecord(blockKey, {
      runId,
      status: 'running',
      output: '',
      truncated: false,
      exitCode: null,
      signal: null,
      startedAt,
      durationMs: null
    })

    const isCurrent = (): boolean => !disposed && records.get(blockKey)?.runId === runId

    const finishWithFailure = (message: string): void => {
      if (settled || !isCurrent()) {
        return
      }
      settled = true
      cancelActive(blockKey)
      const current = records.get(blockKey)
      if (!current || current.runId !== runId) {
        return
      }
      setRecord(blockKey, {
        ...current,
        status: 'failed',
        durationMs: Date.now() - current.startedAt,
        error: message
      })
    }

    void transport(
      { command, language },
      {
        onFrame: (frame) => {
          if (settled || !isCurrent()) {
            return
          }
          const current = records.get(blockKey)
          if (!current || current.runId !== runId) {
            return
          }
          if (frame.type === 'started') {
            setRecord(blockKey, { ...current, cwd: frame.cwd })
            return
          }
          if (frame.type === 'output') {
            const nextOutput = appendBoundedCodeBlockOutput(
              current.output,
              frame.text,
              current.truncated
            )
            setRecord(blockKey, {
              ...current,
              output: nextOutput.output,
              truncated: nextOutput.truncated
            })
            return
          }
          settled = true
          cancelActive(blockKey)
          setRecord(blockKey, {
            ...current,
            status: frame.status,
            exitCode: frame.exitCode,
            signal: frame.signal,
            durationMs: frame.durationMs,
            truncated: current.truncated || frame.truncated,
            ...(frame.error ? { error: frame.error } : {})
          })
        },
        onError: (message) => {
          finishWithFailure(message)
        },
        onClose: () => {
          if (settled || !isCurrent()) {
            return
          }
          finishWithFailure('Connection closed before command finished')
        }
      }
    )
      .then((subscription) => {
        if (settled || !isCurrent()) {
          subscription.unsubscribe()
          return
        }
        activeSubscriptions.set(blockKey, { runId, unsubscribe: subscription.unsubscribe })
      })
      .catch((error: unknown) => {
        finishWithFailure(extractCodeBlockRunErrorMessage(error))
      })
  }

  const stop = (blockKey: string): void => {
    const current = records.get(blockKey)
    if (!current || current.status !== 'running') {
      return
    }
    cancelActive(blockKey)
    setRecord(blockKey, {
      ...current,
      status: 'cancelled',
      durationMs: Date.now() - current.startedAt
    })
  }

  const clear = (blockKey: string): void => {
    cancelActive(blockKey)
    if (records.delete(blockKey)) {
      notify(blockKey)
    }
  }

  const dispose = (): void => {
    disposed = true
    for (const active of activeSubscriptions.values()) {
      try {
        active.unsubscribe()
      } catch {
        /* ignore teardown errors */
      }
    }
    activeSubscriptions.clear()
  }

  const subscribe = (blockKey: string, listener: () => void): (() => void) => {
    let set = listenersByKey.get(blockKey)
    if (!set) {
      set = new Set()
      listenersByKey.set(blockKey, set)
    }
    set.add(listener)
    return () => {
      const current = listenersByKey.get(blockKey)
      if (!current) {
        return
      }
      current.delete(listener)
      if (current.size === 0) {
        listenersByKey.delete(blockKey)
      }
    }
  }

  const getSnapshot = (blockKey: string): NativeChatCodeBlockRunRecord | undefined =>
    records.get(blockKey)

  return { subscribe, getSnapshot, run, stop, clear, dispose }
}
