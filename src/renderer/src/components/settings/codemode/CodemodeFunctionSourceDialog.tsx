import { useEffect, useState } from 'react'
import type React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiCoarseRelativeTime } from '@/i18n/relative-time-format'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type {
  CodemodeLibEntryView,
  CodemodeLibVersion
} from '../../../../../shared/codemode/codemode-lib-types'
import { NativeChatHighlightedCode } from '../../native-chat/markdown/code/NativeChatHighlightedCode'
import { codemodeConnectorErrorMessage } from './codemode-connectors-client'
import {
  codemodeFunctionHistory,
  readCodemodeFunction,
  type CodemodeLibProject
} from './codemode-lib-client'

type Source =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; text: string }

/** The function's source with its saved versions; a version opens in place of the current file. */
export function CodemodeFunctionSourceDialog({
  fn,
  projectRoot,
  open,
  onOpenChange
}: {
  fn: CodemodeLibEntryView
  projectRoot: CodemodeLibProject
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { name, scope } = fn
  // null: the current file.
  const [version, setVersion] = useState<string | null>(null)
  const [source, setSource] = useState<Source>({ kind: 'loading' })
  const [versions, setVersions] = useState<CodemodeLibVersion[]>([])
  // Read once per mount: ages in the list need not tick while the dialog is open.
  const [now] = useState(() => Date.now())

  useEffect(() => {
    if (!open) {
      setVersion(null)
      return undefined
    }
    let live = true
    void codemodeFunctionHistory(projectRoot, name, scope).then(
      (found) => live && setVersions([...found].sort((a, b) => b.savedAt - a.savedAt)),
      () => live && setVersions([])
    )
    return () => {
      live = false
    }
  }, [open, projectRoot, name, scope])

  useEffect(() => {
    if (!open) {
      return undefined
    }
    let live = true
    setSource({ kind: 'loading' })
    void readCodemodeFunction(projectRoot, name, scope, version ?? undefined).then(
      (text) => live && setSource({ kind: 'ready', text }),
      (caught: unknown) =>
        live && setSource({ kind: 'error', message: codemodeConnectorErrorMessage(caught) })
    )
    return () => {
      live = false
    }
  }, [open, projectRoot, name, scope, version])

  const choice = (value: string | null, label: string, title?: string): React.JSX.Element => (
    <Button
      key={value ?? 'current'}
      title={title}
      variant={version === value ? 'secondary' : 'ghost'}
      size="xs"
      aria-pressed={version === value}
      className="justify-start"
      onClick={() => setVersion(value)}
    >
      {label}
    </Button>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent surface="security" scrollable className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t('settings.codemode.functions.sourceTitle', 'Saved function {{name}}', { name })}
          </DialogTitle>
          <DialogDescription>
            {fn.description || t('settings.codemode.functions.noDescription', 'No description.')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <pre
            aria-busy={source.kind === 'loading'}
            className="max-h-[60vh] min-h-32 overflow-auto whitespace-pre rounded-md border border-border bg-muted/30 p-3 font-mono text-xs scrollbar-sleek"
          >
            {source.kind === 'ready' ? (
              <NativeChatHighlightedCode code={source.text} language="javascript" />
            ) : source.kind === 'error' ? (
              <span role="alert" className="text-destructive">
                {source.message}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t('settings.codemode.functions.readingSource', 'Reading the source…')}
              </span>
            )}
          </pre>
          <nav
            aria-label={t('settings.codemode.functions.history', 'History')}
            className="flex min-w-0 flex-col gap-0.5"
          >
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
              {t('settings.codemode.functions.history', 'History')}
            </p>
            {choice(null, t('settings.codemode.functions.current', 'Current'))}
            {versions.map((entry) =>
              choice(
                entry.version,
                formatUiCoarseRelativeTime(entry.savedAt - now),
                uiDateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(entry.savedAt)
              )
            )}
            {versions.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">
                {t('settings.codemode.functions.noHistory', 'No earlier versions.')}
              </p>
            ) : null}
          </nav>
        </div>
      </DialogContent>
    </Dialog>
  )
}
