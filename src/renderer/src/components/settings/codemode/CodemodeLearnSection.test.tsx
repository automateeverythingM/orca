// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  CodemodeLearnListView,
  CodemodeLearnStatusView,
  CodemodeRepeatedChain,
  CodemodeRepeatedScript
} from '../../../../../shared/codemode/codemode-learn-types'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import * as client from './codemode-learn-client'
import { CodemodeLearnSection } from './CodemodeLearnSection'

vi.mock('./codemode-learn-client', async (importActual) => ({
  ...(await importActual<typeof client>()),
  codemodeLearnStatus: vi.fn(),
  listCodemodeRepeats: vi.fn(),
  dismissCodemodeRepeat: vi.fn(async () => {}),
  clearCodemodeLearn: vi.fn(async () => {})
}))

const SEEN = 1_800_000_000_000
const SCRIPT: CodemodeRepeatedScript = {
  kind: 'script',
  shape: 'f'.repeat(64),
  sessions: 3,
  runs: 5,
  lastSeen: SEEN,
  sampleCode: 'return await mcp.crm.find({})',
  tools: ['mcp.crm.find', 'mcp.crm.update'],
  projectRoots: ['/repo']
}
const CHAIN: CodemodeRepeatedChain = {
  kind: 'chain',
  signature: 'opaque-key',
  tools: ['a.b', 'c.d', 'e.f'],
  sessions: 2,
  occurrences: 2,
  lastSeen: SEEN
}
const EMPTY: CodemodeLearnListView = { scripts: [], chains: [], chainsComputedAt: null }
const writeClipboardText = vi.fn(async () => {})

function answer(status: CodemodeLearnStatusView, list: CodemodeLearnListView = EMPTY): void {
  vi.mocked(client.codemodeLearnStatus).mockResolvedValue(status)
  vi.mocked(client.listCodemodeRepeats).mockResolvedValue(list)
}

async function show(enabled: boolean, updateSettings = vi.fn()): Promise<void> {
  const settings = { ...getDefaultSettings('/home/test'), codemodeLearnEnabled: enabled }
  await act(async () => {
    render(<CodemodeLearnSection settings={settings} updateSettings={updateSettings} />)
  })
}

const click = async (name: string, nth = 0): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name })[nth] ?? document.body)
  })
}

beforeEach(() => {
  vi.stubGlobal('api', { ui: { writeClipboardText } })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('switch off with nothing stored asks to turn Learn on', async () => {
  answer({ enabled: false, stats: { runs: 0, calls: 0, bytes: 0, oldest: null } })
  const updateSettings = vi.fn()
  await show(false, updateSettings)
  expect(screen.getByText('Turn on Learn to find scripts you repeat.')).toBeTruthy()
  expect(
    screen.getByText(
      'Keeps your scripts and their results on this computer for 30 days to find work you repeat.'
    )
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Learn from code mode runs' }))
  })
  expect(updateSettings).toHaveBeenCalledWith({ codemodeLearnEnabled: true })
})

it('switch on with nothing repeated shows the stats and the empty line', async () => {
  answer({ enabled: true, stats: { runs: 1, calls: 2, bytes: 3 * 1024 * 1024, oldest: 1 } })
  await show(true)
  expect(screen.getByText('1 run recorded, 3.0 MB')).toBeTruthy()
  expect(
    screen.getByText(
      'Nothing repeated yet. Scripts and tool chains used in 2 or more chats show up here.'
    )
  ).toBeTruthy()
})

it('lists scripts and chains; copies the save request and dismisses', async () => {
  answer(
    { enabled: true, stats: { runs: 12, calls: 30, bytes: 1024 * 1024, oldest: 1 } },
    { scripts: [SCRIPT], chains: [CHAIN], chainsComputedAt: 1 }
  )
  await show(true)
  expect(screen.getByText('12 runs recorded, 1.0 MB')).toBeTruthy()
  expect(screen.getByText('a.b → c.d → e.f')).toBeTruthy()
  expect(screen.getByText('2 chats')).toBeTruthy()
  expect(screen.getByText(/^3 chats · 5 runs · last /)).toBeTruthy()
  expect(screen.queryByText(SCRIPT.sampleCode)).toBeNull()
  await click('Sample code')
  expect(screen.getByText(SCRIPT.sampleCode)).toBeTruthy()

  await click('Copy save request', 1)
  expect(writeClipboardText).toHaveBeenCalledWith(client.learnSaveRequest(CHAIN))
  expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

  const reads = vi.mocked(client.listCodemodeRepeats).mock.calls.length
  await click('Dismiss', 0)
  expect(client.dismissCodemodeRepeat).toHaveBeenCalledWith(SCRIPT)
  expect(vi.mocked(client.listCodemodeRepeats).mock.calls.length).toBe(reads + 1)
})

it('Clear asks first, then clears and reads again', async () => {
  answer({ enabled: false, stats: { runs: 4, calls: 9, bytes: 2048, oldest: 1 } })
  await show(false)
  await click('Clear')
  expect(client.clearCodemodeLearn).not.toHaveBeenCalled()
  expect(screen.getByText(/^Delete every recorded run/)).toBeTruthy()
  await click('Clear', 1)
  expect(client.clearCodemodeLearn).toHaveBeenCalledOnce()
  expect(screen.queryByText(/^Delete every recorded run/)).toBeNull()
})
