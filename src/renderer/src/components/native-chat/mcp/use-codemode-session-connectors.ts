import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store/index'
import type { CodemodeSessionConnectorView } from '../../../../../shared/codemode/codemode-connector-types'
import {
  codemodeConnectorErrorMessage,
  listCodemodeSessionConnectors,
  toggleCodemodeSessionConnector
} from '../../settings/codemode/codemode-connectors-client'

export type CodemodeSessionConnectorsState = {
  connectors: CodemodeSessionConnectorView[]
  /** A refused switch's words, by connector id. */
  errors: Record<string, string>
  toggle: (id: string, on: boolean) => void
}

/**
 * This chat's code mode connectors, read each time the tray opens. Empty when code mode is off or
 * the chat has none (the read is refused), so the tray shows no section.
 */
export function useCodemodeSessionConnectors(
  sessionId: string,
  opens: number
): CodemodeSessionConnectorsState {
  const codemodeOn = useAppStore((state) => state.settings?.codemodeEnabled === true)
  const [connectors, setConnectors] = useState<CodemodeSessionConnectorView[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    setErrors({})
    if (!codemodeOn) {
      setConnectors([])
      return
    }
    listCodemodeSessionConnectors(sessionId).then(
      (list) => live && setConnectors(list),
      () => live && setConnectors([])
    )
    return () => {
      live = false
    }
  }, [sessionId, opens, codemodeOn])
  const toggle = useCallback(
    (id: string, on: boolean) => {
      const set = (value: boolean): void =>
        setConnectors((list) => list.map((c) => (c.id === id ? { ...c, on: value } : c)))
      setErrors(({ [id]: _cleared, ...rest }) => rest)
      set(on)
      toggleCodemodeSessionConnector(sessionId, id, on).catch((error: unknown) => {
        set(!on)
        setErrors((current) => ({ ...current, [id]: codemodeConnectorErrorMessage(error) }))
      })
    },
    [sessionId]
  )
  return { connectors, errors, toggle }
}
