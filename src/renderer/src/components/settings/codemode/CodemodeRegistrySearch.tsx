import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import type { CodemodeConnectorView } from '../../../../../shared/codemode/codemode-connector-types'
import { SettingsBadge } from '../form-controls/SettingsFormControls'
import {
  addCodemodeConnector,
  codemodeConnectorErrorMessage,
  codemodeUrlHost,
  searchCodemodeRegistry,
  type CodemodeRegistryEntry
} from './codemode-connectors-client'

const SEARCH_DEBOUNCE_MS = 300

type Results = { query: string; entries: CodemodeRegistryEntry[]; nextCursor?: string }

export function CodemodeRegistrySearch({
  onAdded,
  onBusyChange
}: {
  onAdded: (connector: CodemodeConnectorView) => void
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [addError, setAddError] = useState<{ url: string; message: string } | null>(null)
  const ticket = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      ticket.current += 1
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    []
  )

  const fetchPage = (text: string, cursor: string | undefined, own: number): void => {
    void searchCodemodeRegistry(text, cursor).then(
      (page) => {
        if (ticket.current !== own) {
          return
        }
        setResults((current) => ({
          query: text,
          entries: cursor && current ? [...current.entries, ...page.entries] : page.entries,
          nextCursor: page.nextCursor
        }))
        setError(null)
        setSearching(false)
      },
      (caught: unknown) => {
        if (ticket.current === own) {
          setError(codemodeConnectorErrorMessage(caught))
          setSearching(false)
        }
      }
    )
  }

  const search = (next: string): void => {
    setQuery(next)
    if (timer.current) {
      clearTimeout(timer.current)
    }
    const own = ++ticket.current
    const text = next.trim()
    setError(null)
    if (!text) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    timer.current = setTimeout(() => fetchPage(text, undefined, own), SEARCH_DEBOUNCE_MS)
  }

  const more = (): void => {
    if (results?.nextCursor) {
      setSearching(true)
      fetchPage(results.query, results.nextCursor, ++ticket.current)
    }
  }

  const add = async (entry: CodemodeRegistryEntry): Promise<void> => {
    setAdding(entry.url)
    setAddError(null)
    onBusyChange(true)
    try {
      onAdded(await addCodemodeConnector(entry.url))
    } catch (caught: unknown) {
      setAddError({ url: entry.url, message: codemodeConnectorErrorMessage(caught) })
    }
    setAdding(null)
    onBusyChange(false)
  }

  const status = searching
    ? t('settings.codemode.registry.searching', 'Searching the MCP Registry…')
    : error
      ? null
      : !results
        ? t('settings.codemode.registry.hint', 'Search by name, such as “github” or “notion”.')
        : results.entries.length === 0
          ? t('settings.codemode.registry.none', 'No remote servers match “{{query}}”.', {
              query: results.query
            })
          : null
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          inset="leadingIcon"
          value={query}
          maxLength={200}
          aria-label={t('settings.codemode.registry.searchLabel', 'Search the MCP Registry')}
          placeholder={t('settings.codemode.registry.placeholder', 'Search the MCP Registry')}
          onChange={(event) => search(event.target.value)}
        />
      </div>
      {results && results.entries.length > 0 ? (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border scrollbar-sleek">
          {results.entries.map((entry) => (
            <li key={entry.url} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{entry.title}</span>
                  <SettingsBadge tone="muted" className="shrink-0">
                    {entry.auth === 'oauth'
                      ? t('settings.codemode.registry.authSignIn', 'Sign in')
                      : t('settings.codemode.registry.authToken', 'Token')}
                  </SettingsBadge>
                </div>
                {entry.description ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
                ) : null}
                <p className="truncate font-mono text-2xs text-muted-foreground">
                  {codemodeUrlHost(entry.url)}
                </p>
                {addError?.url === entry.url ? (
                  <p role="alert" className="text-xs text-destructive">
                    {addError.message}
                  </p>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="xs"
                disabled={adding !== null}
                aria-label={t('settings.codemode.registry.addNamed', 'Add {{name}}', {
                  name: entry.title
                })}
                onClick={() => void add(entry)}
              >
                {adding === entry.url ? <Loader2 className="animate-spin" /> : null}
                {t('settings.codemode.registry.add', 'Add')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {results?.nextCursor && !searching ? (
        <Button variant="ghost" size="xs" onClick={more}>
          {t('settings.codemode.registry.more', 'More results')}
        </Button>
      ) : null}
    </div>
  )
}
