import { describe, expect, it } from 'vitest'
import type { NativeChatCodeBlockRunFrame } from '../../../../../../shared/native-chat/code-block-run/native-chat-code-block-run-types'
import { createNativeChatCodeBlockRunStore } from './native-chat-code-run-store'

describe('createNativeChatCodeBlockRunStore', () => {
  it('stays runnable after dispose (React Activity / StrictMode lifecycle) while cancelling stale streams', async () => {
    const handlersList: {
      onFrame: (frame: NativeChatCodeBlockRunFrame) => void
      onError: (message: string) => void
      onClose: () => void
    }[] = []
    let unsubscribed = 0
    const store = createNativeChatCodeBlockRunStore(async (_args, handlers) => {
      handlersList.push(handlers)
      return {
        unsubscribe: () => {
          unsubscribed += 1
        }
      }
    })

    store.run({ blockKey: 'row:1', command: 'echo first', language: 'bash' })
    await Promise.resolve()
    expect(store.getSnapshot('row:1')?.status).toBe('running')

    store.dispose()
    expect(unsubscribed).toBe(1)

    // Stale frames from before dispose must be ignored.
    handlersList[0].onFrame({ type: 'output', stream: 'stdout', text: 'stale' })
    expect(store.getSnapshot('row:1')?.output).toBe('')

    // Running again after dispose (e.g. Activity reappear) must start a fresh run cleanly.
    store.run({ blockKey: 'row:1', command: 'echo second', language: 'bash' })
    await Promise.resolve()
    handlersList[1].onFrame({ type: 'output', stream: 'stdout', text: 'fresh\n' })
    handlersList[1].onFrame({
      type: 'exit',
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      durationMs: 12,
      truncated: false
    })

    expect(store.getSnapshot('row:1')).toMatchObject({
      status: 'succeeded',
      output: 'fresh\n',
      exitCode: 0,
      durationMs: 12
    })
  })
})
