import { describe, expect, it } from 'vitest'
import { parseRegistryPage, searchRegistry } from './codemode-registry-search'

const FIXTURE = {
  servers: [
    {
      server: {
        name: 'app.linear/linear',
        title: 'Linear',
        description: 'Issues',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }]
      },
      _meta: {}
    },
    {
      server: {
        name: 'io.github.x/broker',
        remotes: [{ type: 'sse', url: 'https://x.example/sse' }]
      }
    },
    {
      server: {
        name: 'io.github.y/paid',
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://y.example/mcp',
            headers: [{ name: 'payment-signature' }]
          }
        ]
      }
    },
    {
      server: {
        name: 'ai.smithery/notion',
        description: 'N',
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://s.example/notion/mcp',
            headers: [{ name: 'Authorization', isSecret: true, value: 'Bearer {k}' }]
          }
        ],
        icons: [{ src: 'http://insecure.example/a.png' }, { src: 'https://s.example/i.svg' }]
      }
    },
    { server: { name: 'io.local/stdio', packages: [{ registryType: 'npm' }] } },
    {
      server: {
        name: 'app.linear/linear-dup',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }]
      }
    }
  ],
  metadata: { nextCursor: 'abc' }
}

describe('parseRegistryPage', () => {
  it('keeps remote streamable-http servers and drops the rest', () => {
    const page = parseRegistryPage(FIXTURE)
    expect(page.nextCursor).toBe('abc')
    expect(page.entries).toEqual([
      {
        name: 'app.linear/linear',
        title: 'Linear',
        description: 'Issues',
        url: 'https://mcp.linear.app/mcp',
        auth: 'oauth'
      },
      {
        name: 'ai.smithery/notion',
        title: 'notion',
        description: 'N',
        url: 'https://s.example/notion/mcp',
        auth: 'token',
        iconUrl: 'https://s.example/i.svg'
      }
    ])
  })

  it('returns no entries for malformed input and skips bad entries', () => {
    expect(parseRegistryPage('nope')).toEqual({ entries: [] })
    expect(parseRegistryPage({ servers: [42, { server: 1 }] }).entries).toEqual([])
  })
})

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status })
  }
  return { impl, calls }
}

describe('searchRegistry', () => {
  it('builds the query and parses the page', async () => {
    const { impl, calls } = stubFetch(200, FIXTURE)
    const page = await searchRegistry('lin', { fetch: impl })
    expect(calls[0].url).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=20&search=lin'
    )
    expect(page.entries).toHaveLength(2)
  })

  it('adds the cursor and clamps the limit', async () => {
    const { impl, calls } = stubFetch(200, {})
    await searchRegistry('a b', { fetch: impl, cursor: 'c1', limit: 500 })
    await searchRegistry('x', { fetch: impl, limit: 0 })
    expect(calls[0].url).toContain('limit=100&search=a+b&cursor=c1')
    expect(calls[1].url).toContain('limit=1&')
  })

  it('throws on a non-2xx answer', async () => {
    const { impl } = stubFetch(503, {})
    await expect(searchRegistry('x', { fetch: impl })).rejects.toThrow('MCP Registry answered 503')
  })
})
