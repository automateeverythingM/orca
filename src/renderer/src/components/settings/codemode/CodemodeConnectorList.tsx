import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { CodemodeConnectorView } from '../../../../../shared/codemode/codemode-connector-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { AddCodemodeConnectorDialog } from './AddCodemodeConnectorDialog'
import { CodemodeConnectorRow } from './CodemodeConnectorRow'
import { codemodeConnectorErrorMessage, listCodemodeConnectors } from './codemode-connectors-client'
import {
  CODEMODE_CONNECTORS_TARGET_ID,
  getCodemodeConnectorsSearchEntry
} from './codemode-settings-search'

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; connectors: CodemodeConnectorView[] }

export function CodemodeConnectorList(): React.JSX.Element {
  const t = useTranslate()
  const entry = getCodemodeConnectorsSearchEntry()
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [addOpen, setAddOpen] = useState(false)
  const reads = useRef(0)

  const refresh = useCallback(() => {
    const read = ++reads.current
    void listCodemodeConnectors().then(
      (connectors) => {
        if (reads.current === read) {
          setState({ kind: 'ready', connectors })
        }
      },
      (caught: unknown) => {
        if (reads.current === read) {
          setState({ kind: 'error', message: codemodeConnectorErrorMessage(caught) })
        }
      }
    )
  }, [])

  useEffect(() => {
    refresh()
    return () => {
      reads.current += 1
    }
  }, [refresh])

  const replace = useCallback((connector: CodemodeConnectorView) => {
    setState((current) =>
      current.kind === 'ready'
        ? {
            kind: 'ready',
            connectors: current.connectors.some((item) => item.id === connector.id)
              ? current.connectors.map((item) => (item.id === connector.id ? connector : item))
              : [...current.connectors, connector]
          }
        : current
    )
  }, [])

  const remove = useCallback((id: string) => {
    setState((current) =>
      current.kind === 'ready'
        ? { kind: 'ready', connectors: current.connectors.filter((item) => item.id !== id) }
        : current
    )
  }, [])

  return (
    <>
      <SettingsGroup
        id={CODEMODE_CONNECTORS_TARGET_ID}
        title={entry.title}
        description={entry.description}
        wrapAction
        action={
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus />
            {t('settings.codemode.connectors.add', 'Add connector')}
          </Button>
        }
      >
        {state.kind === 'loading' ? (
          <p data-settings-row="" role="status" className="py-3 text-xs text-muted-foreground">
            {t('settings.codemode.connectors.reading', 'Reading connectors…')}
          </p>
        ) : state.kind === 'error' ? (
          <div data-settings-row="" className="flex flex-wrap items-center gap-2 py-3">
            <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
              {state.message}
            </p>
            <Button variant="outline" size="xs" onClick={refresh}>
              {t('settings.codemode.connectors.retry', 'Try again')}
            </Button>
          </div>
        ) : state.connectors.length === 0 ? (
          <p data-settings-row="" className="py-3 text-xs text-muted-foreground">
            {t(
              'settings.codemode.connectors.empty',
              'No connectors yet. Add one by URL or find one in the MCP Registry.'
            )}
          </p>
        ) : (
          state.connectors.map((connector) => (
            <CodemodeConnectorRow
              key={connector.id}
              connector={connector}
              onChange={replace}
              onRemove={remove}
              onRefresh={refresh}
            />
          ))
        )}
      </SettingsGroup>
      <AddCodemodeConnectorDialog open={addOpen} onOpenChange={setAddOpen} onAdded={replace} />
    </>
  )
}
