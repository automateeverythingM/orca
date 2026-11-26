import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { NativeChatCompressionMode } from '../../../../../../shared/native-chat/input/composer/native-chat-compression'

type CompressionEntry = {
  selected: NativeChatCompressionMode
  applied: NativeChatCompressionMode
}

const DEFAULT_ENTRY: CompressionEntry = { selected: 'off', applied: 'off' }

const entries = new Map<string, CompressionEntry>()
const listeners = new Map<string, Set<() => void>>()

export function readNativeChatCompression(scopeKey: string): CompressionEntry {
  return entries.get(scopeKey) ?? DEFAULT_ENTRY
}

function writeEntry(scopeKey: string, next: CompressionEntry): void {
  const current = readNativeChatCompression(scopeKey)
  if (current.selected === next.selected && current.applied === next.applied) {
    return
  }
  if (next.selected === 'off' && next.applied === 'off') {
    entries.delete(scopeKey)
  } else {
    entries.set(scopeKey, next)
  }
  const scoped = listeners.get(scopeKey)
  if (!scoped) {
    return
  }
  for (const listener of scoped) {
    listener()
  }
}

export function markNativeChatCompressionApplied(
  scopeKey: string,
  mode: NativeChatCompressionMode
): void {
  writeEntry(scopeKey, { ...readNativeChatCompression(scopeKey), applied: mode })
}

export function resetNativeChatCompressionApplied(scopeKey: string): void {
  writeEntry(scopeKey, { ...readNativeChatCompression(scopeKey), applied: 'off' })
}

function subscribeScope(scopeKey: string, listener: () => void): () => void {
  let scoped = listeners.get(scopeKey)
  if (!scoped) {
    scoped = new Set()
    listeners.set(scopeKey, scoped)
  }
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0) {
      listeners.delete(scopeKey)
    }
  }
}

/** Per-chat compression control for the composer toolbar; hidden in edit sessions and launch prompts. */
export function useNativeChatComposerCompression(
  scopeKey: string,
  hidden: boolean
):
  | { mode: NativeChatCompressionMode; onSelect: (mode: NativeChatCompressionMode) => void }
  | undefined {
  const entry = useSyncExternalStore(
    useCallback((listener) => subscribeScope(scopeKey, listener), [scopeKey]),
    () => readNativeChatCompression(scopeKey),
    () => DEFAULT_ENTRY
  )
  const onSelect = useCallback(
    (mode: NativeChatCompressionMode) => {
      writeEntry(scopeKey, { ...readNativeChatCompression(scopeKey), selected: mode })
    },
    [scopeKey]
  )
  return useMemo(
    () => (hidden ? undefined : { mode: entry.selected, onSelect }),
    [entry.selected, hidden, onSelect]
  )
}
