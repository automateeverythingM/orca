import { lookAroundOrchestrationAllowed } from '../../bots/bot-look-around-policy'
import { isOrchestrationMutation } from '../../../shared/orchestration/orchestration-rpc-contract'
import type { OrcaMethodLabel } from './codemode-orca-method-policy'

/** Methods whose handler starts or dispatches an agent session or worker: always ask. */
export const CODEMODE_ORCA_AGENT_LAUNCH_METHODS: ReadonlySet<string> = new Set([
  'agentSession.create',
  'agentSession.ensure',
  'agentSession.restartContinue',
  'agentSession.continueInterrupted',
  'agent.launch',
  'agent.launchReplay',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession',
  // `launchAgent` / `startupAgent` params start an agent with the terminal or workspace.
  'terminal.create',
  'session.tabs.createTerminal',
  'worktree.create',
  'folderWorkspace.create',
  'orchestration.dispatch',
  'orchestration.workerStart',
  'orchestration.run',
  'automation.runNow',
  // A saved prompt, agent and permission mode that the schedule later launches.
  'automation.create',
  'automation.update',
  'bots.create',
  'bots.session.start',
  'bots.kickoff.retry',
  'bots.sendRunAgain',
  'bots.takeOver',
  'bots.groups.send',
  'bots.lookAround.lookNow',
  'bots.suggestions.start',
  'bots.tidyUp.now'
])

/** Methods that send a prompt or start a turn in an existing chat or worker: always ask. */
export const CODEMODE_ORCA_PROMPT_METHODS: ReadonlySet<string> = new Set([
  'agentSession.send',
  'agentSession.sendRecorded',
  'agentSession.queuedMessageSend',
  'agentSession.queuedMessageUpdate',
  'agentSession.queuedMessagesResume',
  'orchestration.send',
  'orchestration.ask',
  'orchestration.reply',
  'orchestration.peerMailDeliver'
])

/** Methods that type raw input into a PTY or run a shell command: shell-equivalent, always ask. */
export const CODEMODE_ORCA_SHELL_INPUT_METHODS: ReadonlySet<string> = new Set([
  'terminal.send',
  'terminal.split',
  'terminal.inferCodexQuestionSkip',
  'emulator.exec'
])

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
    'browser.dropFiles',
    // Reads with side effects: PTY input, page actions, find highlighting.
    'terminal.viewClaudeAgent',
    'browser.find',
    'browser.findInPage',
    // Private history and outbound fetches stay out of read-only mode.
    'aiVault.searchSessions',
    'aiVault.searchStatus',
    'aiVault.resolveSessionTitles',
    'aiVault.listSessions',
    'nativeChat.readSession',
    'linkPreview.get'
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
