import { describe, expect, it } from 'vitest'
import { buildToolDescription } from './codemode-tool-description'

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length
const ORCA_LINE =
  "orca.areas(), orca.describe(area or method), orca.<area>.<method>(params) for Orca's own actions; orca.context() for this chat's ids."

describe('buildToolDescription', () => {
  it('keeps the required phrases and lists the servers within 150 words', () => {
    const text = buildToolDescription({ servers: ['crm', 'linear', 'github'], orca: true })
    expect(text).toContain('3 or more tool calls')
    expect(text).toContain('never `.then`')
    expect(text).toContain('MCP servers: crm, linear, github.')
    expect(text).toContain(ORCA_LINE)
    expect(words(text)).toBeLessThanOrEqual(150)
  })

  it('leaves orca.* out when the chat has no Orca access', () => {
    const text = buildToolDescription({ servers: ['crm'], orca: false })
    expect(text).toContain('3 or more tool calls')
    expect(text).not.toContain('orca.')
  })

  it('says when no server is configured', () => {
    expect(buildToolDescription({ servers: [], orca: false })).toContain(
      'MCP servers: none configured.'
    )
  })
})
