import { useId, useState } from 'react'
import type React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import {
  CODEMODE_CONNECTOR_NAME,
  type CodemodeConnectorView
} from '../../../../../shared/codemode/codemode-connector-types'
import { CodemodeRegistrySearch } from './CodemodeRegistrySearch'
import { addCodemodeConnector, codemodeConnectorErrorMessage } from './codemode-connectors-client'

type AddTab = 'url' | 'registry'

function AddByUrlForm({
  onAdded,
  onCancel,
  onBusyChange
}: {
  onAdded: (connector: CodemodeConnectorView) => void
  onCancel: () => void
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const urlId = useId()
  const nameId = useId()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmedName = name.trim()
  const nameInvalid = trimmedName !== '' && !CODEMODE_CONNECTOR_NAME.test(trimmedName)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!url.trim() || nameInvalid || adding) {
      return
    }
    setAdding(true)
    setError(null)
    onBusyChange(true)
    try {
      onAdded(await addCodemodeConnector(url.trim(), trimmedName || undefined))
    } catch (caught: unknown) {
      setError(codemodeConnectorErrorMessage(caught))
    }
    setAdding(false)
    onBusyChange(false)
  }

  return (
    <form className="space-y-4 pt-2" onSubmit={(event) => void submit(event)}>
      <div className="space-y-1.5">
        <Label htmlFor={urlId}>{t('settings.codemode.add.urlLabel', 'Server URL')}</Label>
        <Input
          id={urlId}
          autoFocus
          inputMode="url"
          spellCheck={false}
          variant="code"
          maxLength={2048}
          value={url}
          placeholder={t('settings.codemode.add.urlPlaceholder', 'https://mcp.example.com/mcp')}
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>
          {t('settings.codemode.add.nameLabel', 'Name')}
          <span className="font-normal text-muted-foreground">
            {t('settings.codemode.add.optional', '(optional)')}
          </span>
        </Label>
        <Input
          id={nameId}
          spellCheck={false}
          variant="code"
          maxLength={40}
          value={name}
          aria-invalid={nameInvalid}
          aria-describedby={`${nameId}-hint`}
          placeholder={t('settings.codemode.add.namePlaceholder', 'Taken from the URL')}
          onChange={(event) => setName(event.target.value)}
        />
        <p id={`${nameId}-hint`} className="text-xs text-muted-foreground">
          {t(
            'settings.codemode.add.nameHint',
            'Agents call it by this name. Lowercase letters, digits, - and _.'
          )}
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('settings.codemode.add.cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={!url.trim() || nameInvalid || adding}>
          {adding ? <Loader2 className="animate-spin" /> : null}
          {t('settings.codemode.add.submit', 'Add')}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function AddCodemodeConnectorDialog({
  open,
  onOpenChange,
  onAdded
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (connector: CodemodeConnectorView) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [tab, setTab] = useState<AddTab>('url')
  const [busy, setBusy] = useState(false)
  const close = (): void => {
    onOpenChange(false)
    setTab('url')
  }
  const added = (connector: CodemodeConnectorView): void => {
    onAdded(connector)
    close()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) {
          return
        }
        if (next) {
          onOpenChange(true)
        } else {
          close()
        }
      }}
    >
      <DialogContent surface="security" scrollable className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.codemode.add.title', 'Add MCP connector')}</DialogTitle>
          <DialogDescription>
            {t(
              'settings.codemode.add.description',
              'A remote MCP server whose tools agents can call from code mode.'
            )}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value === 'registry' ? 'registry' : 'url')}
          >
            <TabsList className="w-full">
              <TabsTrigger value="url">{t('settings.codemode.add.urlTab', 'URL')}</TabsTrigger>
              <TabsTrigger value="registry">
                {t('settings.codemode.add.registryTab', 'Search registry')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="url">
              <AddByUrlForm onAdded={added} onCancel={close} onBusyChange={setBusy} />
            </TabsContent>
            <TabsContent value="registry">
              <CodemodeRegistrySearch onAdded={added} onBusyChange={setBusy} />
            </TabsContent>
          </Tabs>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
