import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatCompressionMode } from '../../../../../../shared/native-chat/input/composer/native-chat-compression'
import { NativeChatComposerActions } from './NativeChatComposerActions'

const noop = (): void => {}
const paint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

const SNAPSHOT: SessionOptionDescriptor[] = [
  {
    id: 'permissionMode',
    label: 'Permissions',
    category: 'mode',
    transport: 'agent-session',
    valueSource: 'applied',
    settable: true,
    kind: {
      type: 'select',
      currentValue: 'ask',
      settingsAgent: 'claude',
      choices: [
        { value: 'ask', label: 'Ask for approval' },
        { value: 'auto', label: 'Approve for me' }
      ]
    }
  },
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    transport: 'agent-session',
    valueSource: 'applied',
    settable: true,
    kind: {
      type: 'select',
      currentValue: 'opus',
      choices: [{ value: 'opus', label: 'Opus 5.5' }]
    }
  }
]

const SURFACE: SessionOptionsSurface = {
  getSnapshot: () => SNAPSHOT,
  subscribe: () => noop,
  setOption: async () => ({ snapshot: SNAPSHOT }),
  invokeAction: async () => ({ snapshot: SNAPSHOT })
}

function CompressionComposerHarness({
  initialMode
}: {
  initialMode: NativeChatCompressionMode
}): React.JSX.Element {
  const [mode, setMode] = useState<NativeChatCompressionMode>(initialMode)
  return (
    <div
      data-composer-field
      className="native-chat-appearance rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5"
    >
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled
        sendDisabled={false}
        isWorking={false}
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={noop}
        onDictationToggle={noop}
        onDictationHoldStart={noop}
        onDictationHoldEnd={noop}
        onSend={noop}
        sessionOptionsSurface={SURFACE}
        sessionOptionsSnapshot={SNAPSHOT}
        compression={{ mode, onSelect: setMode }}
        agent="claude"
      />
    </div>
  )
}

function compressionFixture(options: {
  initialMode: NativeChatCompressionMode
  openMenu?: boolean
  width?: number
}) {
  return defineFixture({
    width: options.width ?? 640,
    store: { settings: getDefaultSettings('/home/fixture') },
    render: () => <CompressionComposerHarness initialMode={options.initialMode} />,
    interact: async (frame) => {
      await paint()
      const trigger = frame.querySelector<HTMLButtonElement>(
        '[data-composer-control="compression"] button'
      )
      if (!trigger) {
        throw new Error('The composer must render the compression picker')
      }
      if (options.openMenu) {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        trigger.click()
        await paint()
        await paint()
      }
    }
  })
}

export const off = compressionFixture({ initialMode: 'off' })
export const terra = compressionFixture({ initialMode: 'terra' })
export const ultra = compressionFixture({ initialMode: 'ultra' })
export const menuOpen = compressionFixture({ initialMode: 'terra', openMenu: true })
export const narrow = compressionFixture({ initialMode: 'ultra', width: 320 })
