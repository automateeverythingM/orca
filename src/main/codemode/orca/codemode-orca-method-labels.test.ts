import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import {
  CODEMODE_ORCA_AGENT_LAUNCH_METHODS,
  CODEMODE_ORCA_OUTWARD_METHODS,
  CODEMODE_ORCA_PRIVATE_READ_METHODS,
  CODEMODE_ORCA_PROMPT_METHODS,
  CODEMODE_ORCA_SHELL_INPUT_METHODS,
  CODEMODE_ORCA_WAKE_METHODS
} from './codemode-orca-method-label-sets'
import { labelOrcaMethod } from './codemode-orca-method-labels'
import { isExposedOrcaMethod } from './codemode-orca-method-policy'

const exposedNames = new Set<string>(
  ALL_RPC_METHODS.filter(isExposedOrcaMethod).map((method) => method.name)
)

// Ruling R15, named in the final review, plus the same class found while pinning the table.
const OUTWARD = [
  'git.push',
  'github.mergePR',
  'gitlab.mergeMR',
  'github.setPRAutoMerge',
  'google.gmail.send',
  'google.drive.share',
  'artifacts.share',
  'artifacts.publish',
  'git.forkSync',
  'hostedReview.create',
  'hostedReview.createStacked',
  'github.uploadAttachment',
  'google.calendar.create',
  'google.calendar.update',
  'google.calendar.respond',
  'github.addIssueComment',
  'github.addPRReviewComment',
  'github.addPRReviewCommentReply',
  'github.project.addIssueCommentBySlug',
  'gitlab.addIssueComment',
  'gitlab.addMRComment',
  'gitlab.addMRInlineComment',
  'jira.addIssueComment',
  'linear.addIssueComment',
  'linear.issueAddComment',
  'google.docs.comment',
  'connector.reply',
  'connector.act',
  'connector.slackMirror.post',
  'connector.slackMirror.set'
]

// Ruling R16, named in the final review, plus the same class found while pinning the table.
const PRIVATE_READS = [
  'agentSession.history',
  'agentSession.item',
  'agentSession.readVisual',
  'session.readTerminalScrollback',
  'terminal.read',
  'google.gmail.read',
  'google.gmail.search',
  'google.drive.read',
  'google.drive.search',
  'google.docs.read',
  'google.sheets.read',
  'browser.storage.local.get',
  'browser.storage.session.get',
  'agent.read',
  'agentSession.conversationOutline',
  'agentSession.currentRequests',
  'agentSessionAttachment.read',
  'agentSessionAttachment.readTextChunk',
  'notifications.getMissedSince',
  'google.drive.list',
  'google.calendar.list',
  'google.calendar.get',
  'google.contacts.find'
]

// Ruling R1, found while pinning the table.
const LATE_AGENT_LAUNCHES = ['orchestration.federationAttachStart', 'orchestration.partyOpen']

describe('Orca method labels', () => {
  it('labels outward sends, shares, publishes, pushes and merges destructive', () => {
    for (const name of OUTWARD) {
      expect(exposedNames.has(name), name).toBe(true)
      expect(labelOrcaMethod(name), name).toBe('destructive')
    }
  })

  it('labels private reads of other chats, terminals and accounts write, not read', () => {
    for (const name of PRIVATE_READS) {
      expect(exposedNames.has(name), name).toBe(true)
      expect(labelOrcaMethod(name), name).toBe('write')
    }
  })

  it('labels agent launches found while pinning the table destructive', () => {
    for (const name of LATE_AGENT_LAUNCHES) {
      expect(exposedNames.has(name), name).toBe(true)
      expect(labelOrcaMethod(name), name).toBe('destructive')
    }
  })

  it('puts each method in at most one label class', () => {
    const classes = [
      CODEMODE_ORCA_AGENT_LAUNCH_METHODS,
      CODEMODE_ORCA_PROMPT_METHODS,
      CODEMODE_ORCA_SHELL_INPUT_METHODS,
      CODEMODE_ORCA_WAKE_METHODS,
      CODEMODE_ORCA_OUTWARD_METHODS,
      CODEMODE_ORCA_PRIVATE_READ_METHODS
    ]
    const seen = new Map<string, number>()
    for (const names of classes) {
      for (const name of names) {
        seen.set(name, (seen.get(name) ?? 0) + 1)
      }
    }
    expect([...seen].filter(([, count]) => count > 1)).toEqual([])
    for (const name of CODEMODE_ORCA_OUTWARD_METHODS) {
      expect(labelOrcaMethod(name), name).toBe('destructive')
    }
    for (const name of CODEMODE_ORCA_PRIVATE_READ_METHODS) {
      expect(labelOrcaMethod(name), name).toBe('write')
    }
  })
})
