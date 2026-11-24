import type { ZodType } from 'zod'
import { lookAroundOrchestrationAllowed } from '../../bots/bot-look-around-policy'
import { isOrchestrationMutation } from '../../../shared/orchestration/orchestration-rpc-contract'

export type OrcaMethodLabel = 'read' | 'write' | 'destructive'

/** The fields of a runtime RPC method the code-mode policy reads. */
export type OrcaMethodSource = {
  name: string
  permission: string
  params: ZodType | null
  stream?: boolean
}

const SECRET_NAME =
  /(auth|token|credential|secret|password|apikey|api-key|oauth|signin|signout|login|logout|pairing|cookie)/i

const EXCLUDED_AREAS: ReadonlySet<string> = new Set([
  'codemode',
  'accounts',
  'orcaAccount',
  'pairing',
  'pairedServerAsks',
  'mobileRelay',
  'settings',
  'plugins',
  'skills',
  'updater',
  'managedRuntime',
  'orcad'
])

// Why: a script must never answer or change its own chat's approvals, questions or mode.
const AGENT_SESSION_SELF_CONTROL = /respond|answer|approv|permission|setoption/i

/** Workspace methods a script must never reach although the rules above let them through. */
export const CODEMODE_ORCA_DENIED_METHODS: ReadonlySet<string> = new Set([
  // Approvals, questions and permission mode.
  'agentSession.respondToApproval',
  'agentSession.respondToQuestion',
  'agentSession.setOption',
  'agentSession.approveAutoReviewDenial',
  'agentSession.skipAsyncQuestions',
  'orchestration.approvalAnswer',
  'bots.access.decide',
  // Keys, secrets and account sign-in.
  'webhooks.secret',
  'webhooks.reveal',
  'webhooks.rotate',
  'browser.setCredentials',
  'google.client.import',
  'google.client.export',
  'google.disconnect',
  'google.default.set',
  'google.bot.set',
  'bots.googleSetup.read',
  'bots.googleSetup.write',
  'bots.googleSetup.answer',
  'bots.googleSetup.start',
  'bots.googleSetup.importHostKey',
  'bots.composio.setKey',
  'bots.composio.key',
  'bots.composio.removeKey',
  'bots.composio.declineKey',
  'bots.composio.connect',
  'bots.composio.cancelConnect',
  'bots.composio.disconnect',
  'speech.openAiKey.status'
])

export function orcaMethodArea(name: string): string {
  return name.split('.')[0] ?? name
}

export function isExposedOrcaMethod(method: OrcaMethodSource): boolean {
  const area = orcaMethodArea(method.name)
  return (
    method.permission === 'workspace' &&
    method.stream !== true &&
    !SECRET_NAME.test(method.name) &&
    !EXCLUDED_AREAS.has(area) &&
    !CODEMODE_ORCA_DENIED_METHODS.has(method.name) &&
    !(area === 'agentSession' && AGENT_SESSION_SELF_CONTROL.test(method.name))
  )
}

const READ_VERBS: ReadonlySet<string> = new Set([
  'list',
  'get',
  'show',
  'status',
  'read',
  'search',
  'find',
  'describe',
  'current',
  'info',
  'details',
  'diff',
  'log',
  'preview',
  'stats',
  'query',
  'resolve',
  'count',
  'exists',
  'peek',
  'inspect',
  'capture',
  'snapshot',
  'view'
])

const DESTRUCTIVE_WORDS = [
  'remove',
  'delete',
  'kill',
  'close',
  'destroy',
  'discard',
  'reset',
  'prune',
  'clean',
  'archive',
  'revoke',
  'uninstall',
  'forget',
  'drop',
  'wipe',
  'purge',
  'terminate',
  'force'
]

// Names the verb heuristic gets wrong: noun-first reads, short verbs, substring false hits.
const LABEL_OVERRIDES: ReadonlyMap<string, OrcaMethodLabel> = new Map([
  ...labelled('destructive', [
    'worktree.rm',
    'repo.rm',
    'terminal.stop',
    'terminal.stopExact',
    'workspaceCleanup.runNow',
    'agentSession.rewind',
    'agentSession.conversationCommand'
  ]),
  ...labelled('write', [
    'git.resolveConflict',
    'github.resolveReviewThread',
    'gitlab.resolveMRDiscussion',
    'repo.saveSparsePreset',
    'terminal.resetInputModes',
    'browser.dropFiles'
  ]),
  ...labelled('read', [
    'repo.sparsePresets',
    'ssh.listRemovedTargetLabels',
    'worktree.ps',
    'worktree.detectedList',
    'worktree.lineageList',
    'git.submoduleStatus',
    'git.upstreamStatus',
    'git.branchDiff',
    'git.commitDiff',
    'git.branchCompare',
    'git.commitCompare',
    'git.refs',
    'git.history',
    'git.blame',
    'git.localBranches',
    'git.atRiskLocalFiles',
    'git.conflictOperation',
    'git.checkIgnored',
    'git.mutationInFlight',
    'git.remoteFileUrl',
    'git.remoteCommitUrl',
    'github.repoSlug',
    'github.repoUpstream',
    'github.rateLimit',
    'github.workItem',
    'github.workItemByOwnerRepo',
    'github.workItemDetails',
    'github.issue',
    'github.prForBranch',
    'github.prChecks',
    'github.prCheckDetails',
    'github.prComments',
    'github.prFileContents',
    'github.project.workItemDetailsBySlug',
    'gitlab.todos',
    'gitlab.rateLimit',
    'gitlab.jobTrace',
    'gitlab.workItemDetails',
    'gitlab.workItemByPath',
    'linear.issueComments',
    'linear.issueContext',
    'linear.teamStates',
    'linear.teamLabels',
    'linear.teamMembers',
    'linear.mcpListIssues',
    'linear.agentSearchIssues',
    'linear.agentTeamList',
    'linear.agentTeamMembers',
    'linear.agentTeamStates',
    'linear.agentTeamLabels',
    'linear.agentIssueList',
    'linear.agentProjectList',
    'jira.issueComments',
    'jira.lookupIssueSummary',
    'browser.tabList',
    'browser.tabShow',
    'browser.tabCurrent',
    'browser.tabAnnotations',
    'browser.tabProfileShow',
    'browser.profileList',
    'browser.extensionList',
    'browser.console',
    'browser.network',
    'browser.is',
    'terminal.agentId',
    'terminal.agentStatus',
    'terminal.isRunningAgent',
    'files.stat',
    'files.pathsExist',
    'files.statTerminalArtifact',
    'agentSession.history',
    'agentSession.conversationOutline',
    'agentSession.item',
    'agentSession.handoffStatus',
    'agentSession.commands',
    'agentSession.options',
    'agentSession.modelCatalog',
    'agentSession.agents',
    'host.platform',
    'stats.summary',
    'diagnostics.memory',
    'computer.capabilities',
    'computer.permissionsStatus',
    'terminalDaemon.severedStatus'
  ])
])

function labelled(label: OrcaMethodLabel, names: readonly string[]): [string, OrcaMethodLabel][] {
  return names.map((name) => [name, label])
}

function lastSegmentWords(name: string): { segment: string; words: string[] } {
  const segment = name.slice(name.lastIndexOf('.') + 1)
  const words = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return { segment: segment.toLowerCase(), words }
}

/** Override table, then existing orchestration classifications, then the last segment's verb. */
export function labelOrcaMethod(name: string): OrcaMethodLabel {
  const override = LABEL_OVERRIDES.get(name)
  if (override) {
    return override
  }
  const { segment, words } = lastSegmentWords(name)
  if (DESTRUCTIVE_WORDS.some((word) => segment.includes(word))) {
    return 'destructive'
  }
  // A look-around read that still mutates without explicit read-only params (orchestration.check) is a write.
  if (lookAroundOrchestrationAllowed(name) && !isOrchestrationMutation(name, undefined)) {
    return 'read'
  }
  if (isOrchestrationMutation(name, undefined)) {
    return 'write'
  }
  return READ_VERBS.has(words[0] ?? '') ? 'read' : 'write'
}
