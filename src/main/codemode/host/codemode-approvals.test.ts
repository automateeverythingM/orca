import { describe, expect, it } from 'vitest'
import { CodemodeApprovals, type Approver, type GateCheck } from './codemode-approvals'

const BASH: GateCheck = {
  gate: { kind: 'bash' },
  allowKey: 'bash',
  prompt: { title: 'Run bash', detail: 'git push' }
}

function asking(answer: Awaited<ReturnType<Approver>>) {
  const asked: string[] = []
  const approver: Approver = async ({ title }) => {
    asked.push(title)
    return answer
  }
  return { asked, approver }
}

describe('CodemodeApprovals', () => {
  it('keeps an allow_session answer for the connection that gave it, not for another one', async () => {
    const approvals = new CodemodeApprovals(() => 'ask')
    const signal = new AbortController().signal
    const agent = {}
    const other = {}
    const first = asking('allow_session')
    expect(await approvals.check(BASH, { ...first, signal, connection: agent })).toBeNull()
    expect(await approvals.check(BASH, { ...first, signal, connection: agent })).toBeNull()
    expect(first.asked).toEqual(['Run bash'])

    const second = asking('deny')
    expect(await approvals.check(BASH, { ...second, signal, connection: other })).toBe(
      'denied by user'
    )
    expect(second.asked).toEqual(['Run bash'])
  })
})
