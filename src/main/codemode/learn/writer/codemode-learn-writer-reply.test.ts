import { describe, expect, it } from 'vitest'
import { definesFunction, parseLibHeader } from '../../lib/codemode-lib-header'
import { draftToLibFile, parseWriterReply } from './codemode-learn-writer-reply'

const reply = (over: Record<string, unknown> = {}) => ({
  worth: true,
  name: 'planForEmail',
  description: 'Look up a customer by email and return their plan.',
  params: [{ name: 'email', type: 'string', description: 'Customer email' }],
  body: 'const c = await mcp.crm.search({ email })\nreturn { plan: c.plan }',
  sample_args: { email: 'a@b.c' },
  expect: ['pro'],
  calls_saved: 2,
  scope: 'global',
  why: 'Ran in 3 chats with only the email changing.',
  ...over
})

const DRAFT = {
  name: 'planForEmail',
  description: 'Look up a customer by email and return their plan.',
  params: [{ name: 'email', type: 'string', description: 'Customer email' }],
  body: 'const c = await mcp.crm.search({ email })\nreturn { plan: c.plan }',
  sampleArgs: { email: 'a@b.c' },
  expect: ['pro'],
  callsSaved: 2,
  scope: 'global' as const,
  why: 'Ran in 3 chats with only the email changing.'
}

describe('parseWriterReply', () => {
  it('reads a valid JSON reply', () => {
    expect(parseWriterReply(JSON.stringify(reply()))).toEqual({ ok: true, draft: DRAFT })
  })

  it('reads JSON inside a ```json fence with prose around it', () => {
    const raw = `Here you go {not json}:\n\n\`\`\`json\n${JSON.stringify(reply(), null, 2)}\n\`\`\`\nDone.`
    expect(parseWriterReply(raw)).toEqual({ ok: true, draft: DRAFT })
  })

  it('takes the first top-level object, braces inside strings included', () => {
    const body = 'if (x) { return "}" }\nreturn { a: 1 }'
    const raw = `Sure. ${JSON.stringify(reply({ body }))} and {"other": 1}`
    const parsed = parseWriterReply(raw)
    expect(parsed.ok && parsed.draft.body).toBe(body)
  })

  it('fails on garbage', () => {
    expect(parseWriterReply('I could not do that.')).toEqual({
      ok: false,
      reason: 'The writer did not reply with a JSON object.'
    })
    expect(parseWriterReply('{ "worth": tru')).toMatchObject({ ok: false })
  })

  it('fails on missing fields and names them', () => {
    const rest: Record<string, unknown> = reply()
    delete rest.body
    delete rest.expect
    const parsed = parseWriterReply(JSON.stringify(rest))
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.reason).toMatch(/body/)
    expect(!parsed.ok && parsed.reason).toMatch(/expect/)
    expect(parseWriterReply(JSON.stringify(reply({ expect: [] })))).toMatchObject({ ok: false })
    expect(parseWriterReply(JSON.stringify(reply({ expect: ['a', 'b', 'c', 'd'] })))).toMatchObject(
      { ok: false }
    )
    expect(parseWriterReply(JSON.stringify(reply({ scope: 'team' })))).toMatchObject({ ok: false })
  })

  it('fails on a bad name', () => {
    const parsed = parseWriterReply(JSON.stringify(reply({ name: 'plan-for-email' })))
    expect(parsed).toEqual({
      ok: false,
      reason: 'The writer chose an invalid function name: plan-for-email'
    })
    expect(parseWriterReply(JSON.stringify(reply({ name: 'a'.repeat(65) })))).toMatchObject({
      ok: false
    })
    expect(
      parseWriterReply(JSON.stringify(reply({ params: [{ name: 'bad-param' }] })))
    ).toMatchObject({ ok: false })
  })

  it('fails on a reserved name', () => {
    expect(parseWriterReply(JSON.stringify(reply({ name: 'describe' })))).toEqual({
      ok: false,
      reason: 'The writer chose a reserved function name: describe'
    })
  })

  it('fails when the writer says it is not worth saving', () => {
    expect(
      parseWriterReply(JSON.stringify({ worth: false, why: 'Each run did different work.' }))
    ).toEqual({ ok: false, reason: 'Not worth saving: Each run did different work.' })
  })
})

describe('draftToLibFile', () => {
  it('round-trips through parseLibHeader and definesFunction', () => {
    const draft = { ...DRAFT, params: [...DRAFT.params, { name: 'verbose' }] }
    const { source, meta } = draftToLibFile(draft)
    expect(meta).toEqual({
      name: 'planForEmail',
      description: DRAFT.description,
      params: draft.params,
      savedBy: 'learn'
    })
    expect(definesFunction(source, 'planForEmail')).toBe(true)
    const parsed = parseLibHeader(source)
    expect(parsed.meta).toEqual(meta)
    expect(parsed.body).toBe(
      `async function planForEmail({ email, verbose }) {\n${DRAFT.body}\n}\n`
    )
    expect(source).toContain('@saved-by learn')
  })

  it('writes an empty parameter list when there are no params', () => {
    const { source } = draftToLibFile({ ...DRAFT, params: [] })
    expect(parseLibHeader(source).body.startsWith('async function planForEmail() {\n')).toBe(true)
  })
})
