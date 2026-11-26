import { lookAroundOrchestrationAllowed } from '../../bots/bot-look-around-policy'
import { isOrchestrationMutation } from '../../../shared/orchestration/orchestration-rpc-contract'
import {
  CODEMODE_ORCA_AGENT_LAUNCH_METHODS,
  CODEMODE_ORCA_OUTWARD_METHODS,
  CODEMODE_ORCA_PRIVATE_READ_METHODS,
  CODEMODE_ORCA_PROMPT_METHODS,
  CODEMODE_ORCA_SHELL_INPUT_METHODS,
  CODEMODE_ORCA_WAKE_METHODS
} from './codemode-orca-method-label-sets'
import type { OrcaMethodLabel } from './codemode-orca-method-policy'

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
export const CODEMODE_ORCA_LABEL_OVERRIDES: ReadonlyMap<string, OrcaMethodLabel> = new Map([
  ...labelled('destructive', [...CODEMODE_ORCA_AGENT_LAUNCH_METHODS]),
  ...labelled('destructive', [...CODEMODE_ORCA_PROMPT_METHODS]),
  ...labelled('destructive', [...CODEMODE_ORCA_SHELL_INPUT_METHODS]),
  ...labelled('destructive', [...CODEMODE_ORCA_WAKE_METHODS]),
  ...labelled('destructive', [...CODEMODE_ORCA_OUTWARD_METHODS]),
  ...labelled('write', [...CODEMODE_ORCA_PRIVATE_READ_METHODS]),
  ...labelled('destructive', [
    'worktree.rm',
    'repo.rm',
    'terminal.stop',
    'terminal.stopExact',
    'workspaceCleanup.runNow',
    'agentSession.rewind',
    'agentSession.conversationCommand',
    'orchestration.taskCreate',
    // Its `status` can complete a gate-blocked task, which readies and dispatches dependents.
    'orchestration.taskUpdate',
    'jira.generateIssueSummary',
    'worktree.restore',
    'browser.eval',
    'browser.clipboardRead',
    'git.abortMerge',
    'git.abortRebase',
    'git.sequencerAbort'
  ]),
  ...labelled('write', [
    'git.resolveConflict',
    'github.resolveReviewThread',
    'gitlab.resolveMRDiscussion',
    'repo.saveSparsePreset',
    'terminal.resetInputModes',
    'browser.dropFiles',
    // Reads with side effects: PTY input, page actions, find highlighting.
    'terminal.viewClaudeAgent',
    'browser.find',
    'browser.findInPage'
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
    'agentSession.handoffStatus',
    'agentSession.commands',
    'agentSession.options',
    'agentSession.modelCatalog',
    'agentSession.agents',
    'host.platform',
    'stats.summary',
    'diagnostics.memory',
    'computer.capabilities',
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
  const override = CODEMODE_ORCA_LABEL_OVERRIDES.get(name)
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
