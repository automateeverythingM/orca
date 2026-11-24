import { describe, expect, it } from 'vitest'
import { buildToolDescription } from './codemode-tool-description'

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

describe('buildToolDescription', () => {
  it('keeps the required phrases and lists the servers within 150 words', () => {
    const text = buildToolDescription({ servers: ['crm', 'linear', 'github'] })
    expect(text).toContain('3 or more tool calls')
    expect(text).toContain('never `.then`')
    expect(text).toContain('MCP servers: crm, linear, github.')
    expect(words(text)).toBeLessThanOrEqual(150)
  })

  it('says when no server is configured', () => {
    expect(buildToolDescription({ servers: [] })).toContain('MCP servers: none configured.')
  })
})
