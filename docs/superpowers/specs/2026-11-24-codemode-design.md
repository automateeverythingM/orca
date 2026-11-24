# Code mode for Orca — design

Date: 2026-11-24
Status: approved in conversation, awaiting written-spec review
Scope: personal fork (`automateeverythingM/orca`), not proposed upstream

## 1. Goal

Let agents in Orca's native chat sessions do multi-step work by writing one short
JavaScript program instead of making many separate tool calls. Inside the program,
MCP servers, remote connectors, Orca's own actions, file tools, shell, and saved
functions are plain async functions.

Example: "find x@y.com, rename to Bob, add to Team A, add 10 credits" becomes one
`run_js` call with four inner calls, one result, and no tool schemas loaded up front.

Success means:

- Agents use `run_js` for tasks needing 3 or more tool calls.
- Schemas of code-mode-only MCP servers (`.orca/mcp.json`) are not loaded into the
  agent's context until a script asks for them.
- Every inner call passes a permission gate that matches the session's permission mode.
- The behaviour is proven by unit, integration, and live end-to-end tests (section 10).

The design copies the user's existing Rust harness
(`~/Desktop/saas/rust-harness`: `crates/harness-native/src/codemode/`,
`crates/harness-native/src/mcp/`, `crates/harness-connectors/`,
`apps/desktop/src-tauri/src/{codemode_host,mcp_server.rs,connector_proxy.rs,learn_panel}`)
and fixes the gaps found in its Learn feature.

## 2. Decisions

| Topic               | Decision                                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions covered    | Native/structured sessions only: Claude (Agent SDK), Codex (app-server), ACP agents with HTTP MCP support, Pi                                                                                                                                                                                 |
| Not covered         | Agents started in plain terminal tabs; ACP agents without `mcpCapabilities.http`                                                                                                                                                                                                              |
| Wrapped MCP servers | Connectors and the project's `.mcp.json` servers also stay available as direct tools (harness behaviour; agents read `.mcp.json` themselves). Servers in `.orca/mcp.json` are code-mode-only: no agent loads them directly, so their schemas cost nothing until a script calls `mcp.describe` |
| Permissions         | Per-inner-call gate (harness behaviour), not one approval per script                                                                                                                                                                                                                          |
| v1 contents         | `mcp.*`, connectors, `orca.*`, file tools + `bash`, `lib.*` saved functions, Learn                                                                                                                                                                                                            |
| Default             | Off. One global switch in Settings › Code mode                                                                                                                                                                                                                                                |

## 3. Architecture

New code lives under `src/main/codemode/`, one folder per unit:

| Unit           | Responsibility                                              |
| -------------- | ----------------------------------------------------------- |
| `server/`      | Loopback MCP server exposing `run_js`                       |
| `sandbox/`     | QuickJS worker that runs one script                         |
| `host/`        | Executes inner calls coming from the worker, after the gate |
| `gate/`        | Pure permission decision function                           |
| `approvals/`   | App-owned approval cards (`cm-` requests)                   |
| `mcp-pool/`    | Per-session lazy pool of MCP servers                        |
| `connectors/`  | Remote connector store, auth, shared upstream pool          |
| `orca-module/` | Generated `orca.*` area index and labels                    |
| `lib/`         | Saved function store and trust                              |
| `learn/`       | Run recording, signals, writer, replay tests, proposals     |
| `runs/`        | Run store pushed to the renderer for display                |

Flow: agent → `run_js` (HTTP MCP) → `server` → new sandbox worker → script calls
`mcp.fcu.add_credits()` → message to `host` → `gate` → `mcp-pool` / connector pool →
result back into the script → printed output and return value → agent.

### 3.1 MCP server (`server/`)

- `@modelcontextprotocol/sdk` (moves from devDependencies to dependencies), `McpServer`
  with streamable HTTP transport, bound to `127.0.0.1:0`.
- One token per session: issued when the session launches, revoked when it ends, stored
  hashed, compared in constant time. Requests with an `Origin` header or a wrong `Host`
  are refused (same checks as `src/main/bots/tool-relay/bot-tool-relay.ts`).
- One tool: `run_js({ code: string })`.
- The tool description is built for each session (section 5.1).
- While a script runs, the server sends a progress notification every 20 s, because
  Claude Code aborts a tool call that is silent for 300 s.

### 3.2 Sandbox (`sandbox/`)

- `quickjs-emscripten` (asyncify build) in a `worker_threads` worker, one worker per run.
- Top-level `await` is enabled. Host calls are async functions that return plain values.
- Enabled built-ins: JSON, Promise, Proxy, RegExp, Map/Set, typed arrays, Date. No
  timers, no network, no file system, no `require`.
- The prelude defines `mcp`, `orca`, `lib`, `read`, `write`, `edit`, `grep`, `find`,
  `bash`, and `print`. Each wraps one host-call message. A `{ ok: false }` result
  throws an `Error` carrying the message (`bash` is the exception, see 6.2).
- `mcp.<server>.<tool>(args)` is built with a Proxy. `mcp.list`, `mcp.describe`, and
  `mcp.call(server, tool, args)` are reserved names; a server with one of those names is
  reached only through `mcp.call`.

Limits (settings can change them):

| Limit                                        | Default                                       |
| -------------------------------------------- | --------------------------------------------- |
| JS time (excluding time spent in host calls) | 30 s                                          |
| Memory                                       | 64 MiB                                        |
| Stack                                        | 512 KiB                                       |
| Inner calls per script                       | 500                                           |
| Output returned to the agent                 | 30 KB, head and tail kept, marker for the cut |
| One tool result inside the script            | 4 MiB                                         |
| `lib` nesting depth                          | 8                                             |

A promise that never settles ends the run with an explicit error. A worker crash fails
that run only.

### 3.3 MCP pool (`mcp-pool/`)

- One pool per session. Servers start lazily on first `describe` or call, restart at
  most once per turn, and are all shut down when the session ends.
- Sources, earlier source wins on a name clash:
  1. Connectors (section 7)
  2. `<worktree>/.orca/mcp.json`
  3. The project's `.mcp.json` (stdio only)
- `mcp.list()` returns server names, plus tool names for servers already started
  (`null` otherwise). It never starts a server.
- `mcp.describe(server)` starts only that server and returns
  `[{ name, description, input_schema }]`.
- MCP content is turned into text; images, audio, and resources become placeholders
  such as `[image png 12KB]`.
- A server that fails to start returns: `server X failed: <last 5 stderr lines>`.

## 4. Gate and approvals

### 4.1 Gate (`gate/`)

`decide(call, mode, trust) → allow | ask | ask-person-only | refuse`. It is a pure
function. `mode` is read from the session record on every call, so a mode change
mid-script takes effect at the next call.

| Call                                 | `ask` / `own`   | `accept-edits` / `auto` | `full-access`   | read-only session |
| ------------------------------------ | --------------- | ----------------------- | --------------- | ----------------- |
| `read` / `grep` / `find`, `mcp.list` | allow           | allow                   | allow           | allow             |
| `write` / `edit`                     | ask             | allow                   | allow           | refuse            |
| `bash`                               | ask             | ask                     | allow           | refuse            |
| `mcp.*` on an untrusted server       | ask             | ask                     | allow           | refuse            |
| `mcp.*` on a trusted server          | allow           | allow                   | allow           | refuse            |
| `orca.*` read                        | allow           | allow                   | allow           | allow             |
| `orca.*` write                       | ask             | allow                   | allow           | refuse            |
| `orca.*` destructive                 | ask             | ask                     | ask             | refuse            |
| First start of a local stdio server  | ask-person-only | ask-person-only         | allow           | refuse            |
| `lib.save`, `lib.trust`              | ask-person-only | ask-person-only         | ask-person-only | refuse            |

- Trust is set per server in Settings. Connectors are untrusted by default.
- `mcp.describe` on a local server that has not been approved triggers the
  first-start approval.

### 4.2 App-owned approval cards (`approvals/`)

Orca has no app-originated approval cards today, so this adds one path:

- `CodemodeApprovalBroker` emits `request.open` into the session's timeline with item
  id prefix `cm-` and `origin: 'app'`, using the existing `AgentJournalApprovalItem`
  shape (`src/shared/agent-session/journal/agent-session-journal-types.ts`).
- The existing `NativeChatApprovalCard` renders it. Options: Allow once, Allow for this
  session (this server+tool, or this Orca method), Deny. `personOnly` is set for
  ask-person-only decisions.
- The answer path routes `cm-` ids to the broker instead of the provider adapter's
  `answerPrompt`.
- Stop cancels the running script and denies every open `cm-` card for that session.

## 5. Injection, display, results

### 5.1 Tool description

The prompt note lives in the `run_js` tool description, so every agent type receives
it. It is at most about 150 words:

- "Use for 3 or more tool calls. Always `await`; never `.then`."
- What a script can reach: `mcp`, `orca`, `lib`, file tools, `bash`, `print`.
- MCP server names only, `orca` area names, and up to 60 `lib.*` signatures.
- "Call `mcp.describe(server)` / `orca.describe(area)` before an unfamiliar tool."

### 5.2 Injection

All agents get it through the single choke point `basis.toolServers()` in
`src/main/runtime/agent-session/launch/structured-agent-launch-composition.ts`.
A new `codemodeToolServer()` factory produces one entry named `orca` whenever code mode
is on (`BotLaunchTools` needs a new public factory because its constructor is private).

| Agent  | Mechanism                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| Claude | HTTP entry with an `Authorization` header and `alwaysLoad: true`                                                    |
| Codex  | `mcp_servers.orca.url` plus `bearer_token_env_var`; token only in the environment                                   |
| ACP    | Only if the agent advertises `mcpCapabilities.http`; otherwise a chat notice "code mode unavailable for this agent" |
| Pi     | Existing `registerMcpServer` extension path                                                                         |

If the server cannot start, the session launches without code mode and shows a notice.

### 5.3 Display of inner calls

- When a `run_js` request arrives, Orca knows the session from the token. It matches the
  agent's running tool row with the same session, tool name, and `code` input, and
  records `callId → runId`.
- A new `CodemodeRunView` renders `run_js` rows: collapsible code, and a live list of
  inner calls (`mcp.fcu.add_credits ✓ 120ms`, `bash ✗`), each expandable to input and
  output. Data comes from `runs/` over IPC.
- If no row matches, nothing is lost: the inner calls are listed in the text result.

### 5.4 Result format

Printed lines, then `=> <final value as JSON>`, trimmed to 30 KB with head and tail
kept. Errors return `isError: true` with the JS stack mapped to script line numbers.

## 6. `orca.*`, file tools, and `bash`

### 6.1 `orca.*`

- Generated at build time from `RPC_PARAMS_BY_METHOD`
  (`src/shared/rpc-contract/rpc-params-catalog.generated.ts`). Method `worktree.create`
  becomes `orca.worktree.create(params)`.
- The generator also emits each method's label: read, write, or destructive. The label
  comes from the verb in the method name (`list`, `get`, `status`, `read`, `search` mean
  read) plus a hand-checked destructive list (deleting worktrees, killing terminals,
  removing repos, and similar).
- `orca.areas()` returns area names. `orca.describe(area)` returns that area's methods
  with JSON Schema from `z.toJSONSchema`.
- Calls go through the in-process RPC dispatch path the `orca` CLI uses, without the
  socket, with the calling session attached as context.
- Never exposed: credential, token, account, and sign-in methods; settings that hold
  secrets; code mode's own methods.

### 6.2 File tools and `bash`

- `read`, `write`, `edit`, `grep`, `find` resolve paths against the session's worktree.
  A path outside it is refused in `ask` mode and asks for approval in other modes.
  `grep` and `find` use the bundled `rg`. `edit` is exact replacement and requires
  exactly one match.
- `bash(cmd, { timeout? })` runs in the session folder with the session environment.
  Default timeout 120 s, maximum 600 s, output 30 KB head and tail. Returns
  `{ exit_code, output }` and does not throw. It runs in its own process group; Stop
  kills the group.

## 7. Connectors

- A connector is a remote MCP server added once by URL. It is available to every chat,
  both as a direct tool and inside `run_js`.
- `connectors.json` in Orca's user data holds id, name, URL, auth kind
  (`oauth` / `token` / `none`), trusted flag, and enabled flag. It never holds secrets.
- Secrets live in Orca's existing credential store (the one bots use for headers).
- OAuth reuses `src/main/bots/tool-oauth/` (discovery, dynamic client registration,
  PKCE, one-shot loopback callback), moved to `src/main/mcp-auth/` and shared by bots and
  connectors. A pasted bearer token is the alternative.
- Refreshes are serialized per connector with an in-process lock. A 401 triggers one
  refresh and one retry.
- `ConnectorPool` keeps one MCP client session per connector for all chats, caches the
  tool list, refreshes it on `tools/list_changed`, and reconnects once on drop before
  reporting "sign in again".
- Direct access: the bot relay is generalized to serve `/c/<connectorId>/mcp`,
  authorized with the session token, and attaches the secret itself.
- The native chat MCP tray gets a per-chat switch for each connector. A connector
  switched off is refused both as a direct tool and inside `run_js`.
- Settings › Code mode › Connectors: add by URL or by searching the official MCP
  Registry, sign in, status, trust switch, remove.

## 8. Saved functions (`lib.*`)

- One function per file with a doc header:

  ```js
  /**
   * @name addCreditsByEmail
   * @description Find FC Urban user by email and add credits.
   * @param {string} email
   * @param {number} amount
   * @saved-by user | agent | learn
   */
  async function addCreditsByEmail({ email, amount }) { ... }
  ```

- Project scope: `<worktree>/.orca/lib/<name>.js` (committed with the repo). Global
  scope: `~/.orca/lib/<name>.js`. Project wins on a name clash. Each save copies the old
  version to `.history/<name>.<timestamp>.js`.
- `lib.<name>(args)` evaluates the source in the same sandbox with the same gate and the
  same call budget. Nesting is limited to 8; recursion fails with "lib recursion".
- `lib.list()` and `lib.describe(name)` give the full list.
- `lib.save({ name, source, scope })` always shows a person-only card with the code,
  name, and scope choice. A "Save as function" button on a finished `run_js` row asks the
  agent to do this.
- Trust: `~/.orca/lib-trust.json` stores SHA-256 per function, keyed by project path or
  `~` for global. An unknown or changed function shows a person-only `lib.trust` card
  (Allow / Ignore) before its first run. Saving through Orca records the hash.
- Settings › Code mode › Functions: list with scope, origin, last used, use count; view,
  delete, move between scopes, view history.

## 9. Learn

1. **Recording.** Each `run_js` run is stored in `codemode-runs.db` (SQLite): session,
   project, duration, success, full code, shape hash, and every inner call's tool,
   input, and output (each output capped at 64 KB). The shape hash is SHA-256 of the
   token stream with literals replaced by `_` and comments and whitespace dropped.
2. **Signals** (no model call):
   - `repeated_script`: the same shape hash in 2 or more sessions within 30 days.
   - `repeated_chain`: the same sequence of 3 or more direct MCP calls in 2 or more
     sessions, read from chat journals.
3. **Triggers.** A manual "Learn from this session" button with an optional hint, and a
   nightly job through Orca's automations system (off by default). Both cap at 5
   proposals per run. The pipeline is signals → rank → top 5 → writer.
4. **Writer.** Opus through Orca's background text generation
   (`--strict-mcp-config`, no tools) on the user's own login. It receives the actual
   code of the repeated scripts, fenced as untrusted data it must not follow. It returns
   `{ worth, name, description, params, body, sample_args, expect[1-3], calls_saved,
   scope, why }`. Invalid JSON or a name that is not a JS identifier marks the proposal
   failed.
5. **Testing.**
   - `mcp.*` and `orca.*` calls are answered from the recorded inputs and outputs of the
     source runs, matched by tool and arguments. Any unrecorded call fails the test.
     Nothing real is called.
   - File tools and `bash` run in a throwaway worktree under an OS sandbox: no network,
     clean environment, 120 s, process group killed. macOS uses `sandbox-exec`; Linux
     uses `bwrap` if installed; otherwise the test is skipped and the proposal is marked
     "untested: no sandbox on this OS".
   - Pass means no throw, every `expect` string appears in the result, and no unrecorded
     calls.
6. **Review.** Settings › Code mode › Learn shows proposal cards: signal, why,
   "saves about N calls", test status including untested with the reason, test log, and
   code. Buttons: Dismiss, Edit, Save (project or global). Save goes through the
   `lib.save` path with `@saved-by learn` and records the trust hash. A late writer or
   test result never overrides Save or Dismiss. After 3 uses the card shows
   "was N calls, now M".

## 10. Testing and proof

### 10.1 Unit and integration (Vitest, `pnpm test`)

| Area                    | Tests                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gate                    | Every table row × every mode                                                                                                                                                   |
| Orca labels             | Every RPC method has a label; excluded-method name check (`auth                                                                                                                | token | credential | secret | password`); area index matches the catalog |
| Approvals               | Broker → journal → answer → script continues; Stop with an open card                                                                                                           |
| Sandbox                 | Each limit; never-settling promise; worker crash isolation; top-level await                                                                                                    |
| Server                  | Token auth, Origin/Host refusal, progress keep-alive                                                                                                                           |
| Description and results | Description builder; 30 KB trimming; row matching (match, no match, duplicate code)                                                                                            |
| Injection               | Each agent's launch config contains `orca` with a token; Claude has `alwaysLoad`                                                                                               |
| Files and bash          | Path scoping (`..`, escaping symlinks, absolute paths); `edit` with 0/1/2 matches; bash timeout and group kill                                                                 |
| Connectors              | Fake OAuth MCP server: sign in, refresh, expired token, revoked; no secrets in `connectors.json`; relay routing; shared upstream; switched-off connector refused in both paths |
| `lib`                   | Header parsing; project over global; history; trust hash states; recursion; save card flow; cloned-function trust card; gate applies inside functions                          |
| Learn                   | Shape hash; both signals; writer JSON parsing; replay matching; state machine; macOS sandbox denies network and outside writes                                                 |

Component fixtures: a `cm-` approval card; `CodemodeRunView` running, finished, failed.

### 10.2 Live end-to-end (`tests/e2e/codemode/`, run manually, needs the user's login)

Each scenario runs against a real Claude session and a real Codex session with code
mode on and a fake in-memory MCP server `fake-crm` (`find_user`, `update_user`,
`add_to_group`, `add_credits`) configured only in the test worktree's `.orca/mcp.json`:

1. Multi-step: "find x@y.com, rename to Bob, add to Team A, add 10 credits". Assert
   `run_js` was used (at most 2 `run_js` calls, no direct `fake-crm` calls) and the final
   `fake-crm` state is correct.
2. Lazy loading: the agent's initial tool list has no `fake-crm` schemas; the script
   called `mcp.describe("fake-crm")`.
3. Gate: in `ask` mode an `add_credits` card appears; Deny makes that call fail and
   leaves state unchanged.
4. `orca.*`: a script lists worktrees; the result matches `orca worktree list`.
5. `lib`: save `addCreditsByEmail`; in a new session the agent calls it; state is correct.
6. Connector: the fake OAuth server is added and signed in; it is called directly and
   inside `run_js`.
7. Learn: run the same script shape in 2 sessions; trigger Learn with a stubbed writer;
   a proposal appears, passes replay testing, and is saved.

Token check: with 5 fake servers × 20 tools, record the initial context size in two
setups and report the difference: servers in `.mcp.json` with code mode off, and the
same servers in `.orca/mcp.json` with code mode on.

## 11. Rollout

One branch per part, merged to the fork's `main` in order. Each part ships behind the
Settings switch and passes its tests before the next part starts.

| Part | Contents                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------- |
| A    | Server, sandbox, host, gate, approvals, MCP pool (local servers), file tools, `bash`, injection, display |
| B    | Connectors                                                                                               |
| C    | `orca.*`                                                                                                 |
| D    | `lib.*`                                                                                                  |
| E    | Learn                                                                                                    |

## 12. Settings › Code mode

On/off; limits; servers with trust switches; Connectors; Functions; Learn (on/off,
nightly on/off).

## 13. Not in v1

- Agents in plain terminal tabs.
- ACP agents without HTTP MCP support.
- Learn proposing skills or notes (functions only).
- Any change proposed to upstream Orca.
