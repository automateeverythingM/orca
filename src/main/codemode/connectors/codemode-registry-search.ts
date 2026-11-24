import { z } from 'zod'

export type RegistryEntry = {
  name: string
  title: string
  description: string
  url: string
  auth: 'oauth' | 'token'
  iconUrl?: string
}

export type RegistryPage = { entries: RegistryEntry[]; nextCursor?: string }

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const REGISTRY_TIMEOUT_MS = 15_000
const DEFAULT_LIMIT = 20

const headerSchema = z.object({ name: z.string(), isSecret: z.boolean().optional() })
const remoteSchema = z.object({
  type: z.string(),
  url: z.string(),
  headers: z.array(headerSchema).optional()
})
const serverSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  remotes: z.array(remoteSchema).optional(),
  icons: z.array(z.object({ src: z.string() })).optional()
})
const pageSchema = z.object({
  servers: z.array(z.unknown()).optional(),
  metadata: z.object({ nextCursor: z.string().optional() }).optional()
})
const wrapperSchema = z.object({ server: serverSchema })

type Remote = z.infer<typeof remoteSchema>

function remoteAuth(remote: Remote): 'oauth' | 'token' | null {
  if (remote.type !== 'streamable-http' || !remote.url.startsWith('https://')) {
    return null
  }
  const headers = remote.headers ?? []
  if (headers.length === 0) {
    return 'oauth'
  }
  const [only] = headers
  if (headers.length === 1 && only.name.toLowerCase() === 'authorization' && only.isSecret) {
    return 'token'
  }
  return null
}

function toEntry(server: z.infer<typeof serverSchema>): RegistryEntry | null {
  for (const remote of server.remotes ?? []) {
    const auth = remoteAuth(remote)
    if (!auth) {
      continue
    }
    const iconUrl = server.icons?.find((icon) => icon.src.startsWith('https://'))?.src
    return {
      name: server.name,
      title: server.title || server.name.split('/').pop() || server.name,
      description: server.description ?? '',
      url: remote.url,
      auth,
      ...(iconUrl ? { iconUrl } : {})
    }
  }
  return null
}

export function parseRegistryPage(json: unknown): RegistryPage {
  const page = pageSchema.safeParse(json)
  if (!page.success) {
    return { entries: [] }
  }
  const entries: RegistryEntry[] = []
  const seen = new Set<string>()
  for (const raw of page.data.servers ?? []) {
    const wrapped = wrapperSchema.safeParse(raw)
    const entry = wrapped.success ? toEntry(wrapped.data.server) : null
    if (entry && !seen.has(entry.url)) {
      seen.add(entry.url)
      entries.push(entry)
    }
  }
  const nextCursor = page.data.metadata?.nextCursor
  return nextCursor ? { entries, nextCursor } : { entries }
}

export async function searchRegistry(
  query: string,
  opts: { cursor?: string; limit?: number; fetch?: typeof fetch; signal?: AbortSignal } = {}
): Promise<RegistryPage> {
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)))
  const params = new URLSearchParams({ version: 'latest', limit: String(limit), search: query })
  if (opts.cursor) {
    params.set('cursor', opts.cursor)
  }
  const timeout = AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  const doFetch = opts.fetch ?? fetch
  const response = await doFetch(`${REGISTRY_URL}?${params.toString()}`, {
    headers: { 'user-agent': 'Orca', accept: 'application/json' },
    signal
  })
  if (!response.ok) {
    throw new Error(`MCP Registry answered ${response.status}`)
  }
  return parseRegistryPage(await response.json().catch(() => null))
}
