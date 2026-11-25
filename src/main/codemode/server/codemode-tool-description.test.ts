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

  const LIB_LINE =
    'lib.<name>(args), lib.list(), lib.describe(name), lib.save({name, source, scope?, description?}) for saved functions.'

  it('lists up to 60 signatures then a more note', () => {
    const sigs = Array.from({ length: 65 }, (_, i) => `f${i}({a})`)
    const text = buildToolDescription({ servers: [], orca: false, lib: sigs })
    expect(text).toContain(LIB_LINE)
    expect(text).toContain(
      `Saved functions: ${sigs.slice(0, 60).join(', ')} (+5 more: lib.list()).`
    )
    expect(text).not.toContain('f60(')
    const few = buildToolDescription({ servers: [], orca: false, lib: ['add({a, b})', 'ping()'] })
    expect(few).toContain('Saved functions: add({a, b}), ping().')
    expect(few).not.toContain('more:')
  })

  it('has the lib line but no saved list when there are none', () => {
    const text = buildToolDescription({ servers: ['crm'], orca: true, lib: [] })
    expect(text).toContain(LIB_LINE)
    expect(text).not.toContain('Saved functions')
    expect(words(text)).toBeLessThanOrEqual(150)
  })

  it('no lib line when the chat has no lib access', () => {
    expect(buildToolDescription({ servers: ['crm'], orca: true })).not.toContain('lib.')
  })
})
