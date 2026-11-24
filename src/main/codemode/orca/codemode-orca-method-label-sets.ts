// Method classes whose label the verb heuristic cannot see from the name alone.

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
  // Starts a worker from a task spec on a paired host.
  'orchestration.federationAttachStart',
  // Resumes a closed terminal worker's conversation in a new terminal.
  'orchestration.partyOpen'
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
  'emulator.exec',
  // `customAgentCommand` / `agentCmdOverrides` run a caller-chosen command on the host.
  'git.generateCommitMessage',
  'git.generatePullRequestFields',
  'git.discoverCommitMessageModels'
])

/** Methods that deliver mail or set work that wakes a worker or chat: always ask. */
export const CODEMODE_ORCA_WAKE_METHODS: ReadonlySet<string> = new Set([
  'agentSession.threadGoal',
  'orchestration.peerMailReturn',
  'webhooks.pause'
])

/** Outward actions other people see, which cannot be taken back: always ask. */
export const CODEMODE_ORCA_OUTWARD_METHODS: ReadonlySet<string> = new Set([
  // Pushes and merges.
  'git.push',
  // Pushes the upstream default branch to the fork's origin.
  'git.forkSync',
  'github.mergePR',
  'github.setPRAutoMerge',
  'gitlab.mergeMR',
  // Opens a pull or merge request on the code host.
  'hostedReview.create',
  'hostedReview.createStacked',
  // Mail, shares and publishes.
  'google.gmail.send',
  'google.drive.share',
  'artifacts.share',
  'artifacts.publish',
  // Puts a local image at a GitHub URL.
  'github.uploadAttachment',
  // Calendar writes email the guests unless `notify: false`.
  'google.calendar.create',
  'google.calendar.update',
  'google.calendar.respond',
  // Comments and replies people are notified of.
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
  // Bot posts to Slack or GitHub, and mirroring a chat into Slack.
  'connector.reply',
  'connector.act',
  'connector.slackMirror.post',
  'connector.slackMirror.set'
])

/** Private reads of other chats, terminals, accounts or projects, and URL fetches: never in read-only. */
export const CODEMODE_ORCA_PRIVATE_READ_METHODS: ReadonlySet<string> = new Set([
  // Other chats' transcripts, requests, attachments and notifications.
  'agent.read',
  'agentSession.history',
  'agentSession.item',
  'agentSession.readVisual',
  'agentSession.conversationOutline',
  'agentSession.currentRequests',
  'agentSessionAttachment.read',
  'agentSessionAttachment.readTextChunk',
  'notifications.getMissedSince',
  'aiVault.searchSessions',
  'aiVault.searchStatus',
  'aiVault.resolveSessionTitles',
  'aiVault.listSessions',
  'nativeChat.readSession',
  // Other terminals' output.
  'session.readTerminalScrollback',
  'terminal.read',
  // The signed-in Google account.
  'google.gmail.read',
  'google.gmail.search',
  'google.drive.read',
  'google.drive.search',
  'google.drive.list',
  'google.docs.read',
  'google.sheets.read',
  'google.calendar.list',
  'google.calendar.get',
  'google.contacts.find',
  // Page storage holds session tokens.
  'browser.storage.local.get',
  'browser.storage.session.get',
  // Outbound fetch.
  'linkPreview.get'
])
