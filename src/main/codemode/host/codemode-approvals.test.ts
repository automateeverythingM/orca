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

  it('asks again after allow_session when the check has no allow key', async () => {
    const approvals = new CodemodeApprovals(() => 'full-access')
    const signal = new AbortController().signal
    const connection = {}
    const check: GateCheck = {
      gate: { kind: 'orca', label: 'destructive' },
      allowKey: null,
      prompt: { title: 'orca.worktree.remove', detail: '{}' }
    }
    const answers = asking('allow_session')
    expect(await approvals.check(check, { ...answers, signal, connection })).toBeNull()
    expect(await approvals.check(check, { ...answers, signal, connection })).toBeNull()
    expect(answers.asked).toHaveLength(2)
  })

  it('remembers allow_session for a keyed orca write check', async () => {
    const approvals = new CodemodeApprovals(() => 'ask')
    const signal = new AbortController().signal
    const connection = {}
    const check: GateCheck = {
      gate: { kind: 'orca', label: 'write' },
      allowKey: 'orca:worktree.create',
      prompt: { title: 'orca.worktree.create', detail: '{}' }
    }
    const answers = asking('allow_session')
    expect(await approvals.check(check, { ...answers, signal, connection })).toBeNull()
    expect(await approvals.check(check, { ...answers, signal, connection })).toBeNull()
    expect(answers.asked).toHaveLength(1)
  })
})
