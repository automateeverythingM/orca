# Code Mode Part A (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native chat agents get one MCP tool, `run_js`, that runs agent-written JavaScript in a QuickJS sandbox where local MCP servers, file tools, and `bash` are functions, with each inner call checked by a permission gate.

**Architecture:** A loopback streamable-HTTP MCP server in Orca's main process serves `run_js` with a token per session. Each run gets a QuickJS worker thread; the worker's host functions post messages to a main-process host that applies the gate, asks the user through MCP elicitation when needed, and executes calls against a lazy per-session MCP pool, the file tools, or `bash`. The server is injected through the same `toolServers()` path bot tools use.

**Tech Stack:** TypeScript, Electron main, `quickjs-emscripten` 0.32.0 (asyncify variant), `@modelcontextprotocol/sdk` 1.32.1, Node `worker_threads`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-codemode-design.md` (sections 3, 4, 5, 6.2, 10, 11 part A). Parts B–E (connectors, `orca.*`, `lib.*`, Learn) get their own plans.

## Deviation from the spec (approvals)

Spec 4.2 planned app-owned `cm-` journal cards. Orca's journal accepts only provider-keyed items (`codex:`, `claude:`, `orca:<clientMessageId>`, `legacy:`), and no non-adapter code can append to a session journal. Instead, the code-mode MCP server sends an MCP `elicitation/create` form request for each `ask` decision. Codex and ACP adapters already render MCP form elicitations as question cards (`src/main/codex/structured/prompts/codex-mcp-form-elicitation.ts`, `src/main/acp/requests/acp-form-elicitation.ts`). Claude needs an `onElicitation` handler (Task 10). The user still sees a card in native chat and answers it; the behaviour in spec 4.1 is unchanged.

Second, smaller deviation: Codex gets the token through `mcp_servers.orca.http_headers.authorization`, because Orca's Codex thread config supports `http_headers` but not `bearer_token_env_var`. The token is per session and revoked at session end.

## Global Constraints

- Feature is off unless global setting `codemodeEnabled` is `true` (default `false`).
- Limits (spec 3.2): JS time 30 s excluding host-call time; memory 64 MiB; stack 512 KiB; 500 inner calls per script; output to agent 30 KB with head and tail kept and a cut marker; one tool result inside the script 4 MiB.
- `bash`: default timeout 120 s, max 600 s, output 30 KB head+tail, own process group, Stop kills the group, returns `{ exit_code, output }`, never throws.
- Server binds `127.0.0.1:0`; token per session, stored hashed (SHA-256), compared with `timingSafeEqual`; requests with an `Origin` header or a `Host` that is not `127.0.0.1:<port>` are refused.
- Progress notification every 20 s while a script runs.
- Tool description at most ~150 words; it must contain the exact phrases "3 or more tool calls" and "never `.then`".
- MCP pool sources in precedence order: `<worktree>/.orca/mcp.json`, then project `.mcp.json` (stdio entries only). Connectors are Part B.
- Server names `list`, `describe`, `call` are reachable only through `mcp.call`.
- Cross-platform: mac/linux/windows. Process-group kill uses existing process wrappers; on Windows use `taskkill /T /F` via the existing helper if one exists (search `src/main` for `taskkill` before writing one).
- Remote hosts: code mode lives beside the structured-session launch code, so it runs on whichever host launches the session. No renderer-only state.
- Folder workspaces: never assume a git worktree; "worktree" below means the session's launch directory.
- Repo rules: `AGENTS.md` (no vague file names, minimal comments, `pnpm check:changed` once when done). Tests are kept because the user explicitly requires them and they cover security boundaries, parsers, and state machines.
- Commits: Conventional Commits, no `Co-Authored-By` trailer.

## Review Focus

1. A script that never awaits a host call but loops forever (`while(true){}`) must end at 30 s with "script exceeded 30s JS time" — Task 2.
2. A path such as `../../etc/passwd` or a symlink inside the worktree pointing outside it must be treated as outside — Task 5.
3. A local MCP server that crashes mid-call must fail that call with its last 5 stderr lines and restart at most once per turn — Task 4.
4. Two concurrent `run_js` calls in the same session must not share sandbox state or call budgets — Task 7.
5. An agent whose MCP client lacks elicitation support must get a clear refusal for `ask` calls, not a hang — Task 9.

---

### Task 1: Dependencies, setting, and limits

**Files:**

- Modify: `package.json` (add `quickjs-emscripten@0.32.0` to `dependencies`; move `@modelcontextprotocol/sdk` from `devDependencies` to `dependencies`), `pnpm-lock.yaml`
- Modify: `src/shared/settings/global-settings-types.ts` (near `nativeChatInlineVisuals`, :213), `src/shared/settings/default-global-settings.ts` (:166), `src/main/runtime/construction/runtime-store-contract.ts` (:231), `src/main/native-chat/agent-session-wire/options/at-rest-command-context.ts` (:20, add to `launchSettings`)
- Create: `src/main/codemode/codemode-limits.ts`

**Interfaces:**

- Produces: `GlobalSettings.codemodeEnabled: boolean` (default `false`); `CODEMODE_LIMITS = { jsTimeMs: 30_000, memoryBytes: 64 * 1024 * 1024, stackBytes: 512 * 1024, maxCalls: 500, outputBytes: 30_000, resultBytes: 4 * 1024 * 1024, bashDefaultMs: 120_000, bashMaxMs: 600_000, progressMs: 20_000 } as const`; type `CodemodeLimits = typeof CODEMODE_LIMITS`.

- [ ] **Step 1:** `pnpm add quickjs-emscripten@0.32.0 && pnpm add @modelcontextprotocol/sdk@1.32.1` (moves it to dependencies). Confirm `pnpm-workspace.yaml` `minimumReleaseAge` accepts it.
- [ ] **Step 2:** Add the setting and constants. Run `pnpm tc:node` — Expected: no errors.
- [ ] **Step 3:** Commit `chore(codemode): add QuickJS dependency, codemodeEnabled setting, limits`.

### Task 2: QuickJS script runner

**Files:**

- Create: `src/main/codemode/sandbox/codemode-script-runner.ts`, `src/main/codemode/sandbox/codemode-prelude.ts`, `src/main/codemode/sandbox/codemode-output-trim.ts`
- Test: `src/main/codemode/sandbox/codemode-script-runner.test.ts`, `src/main/codemode/sandbox/codemode-output-trim.test.ts`

**Interfaces:**

- Produces:
  - `type HostCall = { tool: string; input: unknown }` where `tool` is one of `mcp.list | mcp.describe | mcp.call | read | write | edit | grep | find | bash`.
  - `type HostReply = { ok: true; value: unknown } | { ok: false; error: string }`.
  - `type ScriptHost = (call: HostCall) => Promise<HostReply>`.
  - `type ScriptResult = { ok: true; printed: string[]; value: unknown } | { ok: false; printed: string[]; error: string }`.
  - `runScript(code: string, host: ScriptHost, limits: CodemodeLimits, signal: AbortSignal): Promise<ScriptResult>`.
  - `trimOutput(text: string, maxBytes: number): string` — keeps head and tail halves, inserts `\n…[N bytes cut]…\n`.
  - `formatScriptResult(result: ScriptResult, maxBytes: number): { text: string; isError: boolean }` — printed lines, then `=> <JSON value>`; errors as `Error: <message>`.

Approach: `newAsyncContext()` from `quickjs-emscripten`; `runtime.setMemoryLimit`, `setMaxStackSize`; an interrupt handler that compares accumulated JS time (wall time minus time spent inside host calls) to `jsTimeMs`, and also returns `true` once `signal` aborts. One asyncified global `__host(tool, inputJson)` returns a JSON string; the prelude (a string constant) defines `mcp` (Proxy: `mcp.<server>.<tool>(args)` → `mcp.call`; `list`, `describe`, `call` reserved), `read`, `write`, `edit`, `grep`, `find`, `bash`, `print`. Wrappers throw `Error(message)` on `{ok:false}` except `bash`. Agent code is wrapped as `(async () => { <code> })()`; the result value is the function's `return` value; the resulting promise is resolved with `resolvePromise` + `executePendingJobs`. A promise still pending after the job queue drains and no host call is in flight fails with `script ended with an unsettled promise`. Interrupt maps to `script exceeded 30s JS time`; memory exhaustion to `memory limit 64MB`. The call counter refuses call 501 with `call limit 500 reached`. Host results larger than `resultBytes` fail with `tool result exceeds 4MB`.

- [ ] **Step 1: Write failing tests** in `codemode-script-runner.test.ts` with a stub host:
  - `returns value and printed lines`: code `print("a"); return 1+1` → `{ ok: true, printed: ["a"], value: 2 }`.
  - `host calls look synchronous and await works`: host returns `{ok:true,value:{n:3}}` for `mcp.call`; code `const r = await mcp.crm.find_user({id:1}); return r.n` → value `3`; stub saw `{ tool: 'mcp.call', input: { server: 'crm', tool: 'find_user', args: { id: 1 } } }`.
  - `host error throws inside the script`: host returns `{ok:false,error:'nope'}`; code `try { await read("x") } catch (e) { return e.message }` → `'nope'`.
  - `bash does not throw`: host returns `{ok:true,value:{exit_code:1,output:'x'}}` → code `return (await bash("false")).exit_code` → `1`.
  - `infinite loop stops`: `while(true){}` with `jsTimeMs: 200` → `{ ok: false, error: 'script exceeded 30s JS time' }` (message text uses the configured seconds; assert `/exceeded .*s JS time/`).
  - `host time does not count`: host sleeps 300 ms per call, `jsTimeMs: 200`, code makes 2 calls → ok.
  - `call limit`: `maxCalls: 2`, code makes 3 calls → error `call limit 2 reached`.
  - `memory limit`: `memoryBytes: 8MB`, code builds a 50 MB string → error matches `/memory limit/`.
  - `reserved names`: `mcp.list` and `mcp.describe('x')` send `mcp.list` / `mcp.describe` host calls, not `mcp.call`.
  - `abort`: aborting the signal mid-loop → error `Interrupted by user`.
  - `error line numbers`: code `const a = 1\nnull.x` → error text contains `line 2` (stack positions are shifted by the wrapper's line offset so they match the agent's code).
- [ ] **Step 2:** Tests in `codemode-output-trim.test.ts`: under the limit unchanged; over the limit the result is ≤ maxBytes + marker length, starts with the original head, ends with the original tail, contains `[` + cut byte count + ` bytes cut]`; multi-byte UTF-8 is never split mid-character.
- [ ] **Step 3:** Run `pnpm test src/main/codemode/sandbox --maxWorkers=2` — Expected: FAIL (modules missing).
- [ ] **Step 4:** Implement the three files.
- [ ] **Step 5:** Run the tests — Expected: PASS.
- [ ] **Step 6:** Commit `feat(codemode): QuickJS script runner with limits and output trimming`.

### Task 3: Worker isolation

**Files:**

- Create: `src/main/codemode/sandbox/codemode-worker-entry.ts`, `src/main/codemode/sandbox/codemode-worker-run.ts`
- Modify: `config/build-plugins/main-build-entry-points.ts` (add `'codemode-worker-entry'`), `config/main-blocking-worker-entries.json`, `src/main/worker-threads/worker-thread-roles.ts` (add role `'codemode'`)
- Test: `src/main/codemode/sandbox/codemode-worker-run.test.ts`

**Interfaces:**

- Consumes: `runScript`, `ScriptHost`, `ScriptResult` (Task 2).
- Produces: `runScriptInWorker(code: string, host: ScriptHost, limits: CodemodeLimits, signal: AbortSignal, workerPath?: string): Promise<ScriptResult>`. Messages: worker → main `{ type: 'call', id, call }`, main → worker `{ type: 'reply', id, reply }`, worker → main `{ type: 'done', result }`. Worker exit without `done` resolves `{ ok: false, printed: [], error: 'sandbox crashed (exit <code>)' }`. Abort terminates the worker and resolves `Interrupted by user`.

Spawn with `spawnWorkerThread` and resolve the path like `journal-sql-owner.ts:58-66`. Tests pass `workerPath` pointing at a tiny TS entry run through Vitest's loader, or exercise the entry module through `new Worker` with `execArgv` the repo's existing worker tests use (search `*.test.ts` for `new Worker(` first and copy that pattern).

- [ ] **Step 1: Failing tests:** `round-trips host calls through the worker` (stub host, code calls `read` → value returned); `worker crash is isolated` (code triggers `process.exit` is impossible inside QuickJS, so simulate by terminating the worker from a test hook: kill after first call → result error matches `/sandbox crashed/`); `abort terminates` (loop + abort → `Interrupted by user`, worker `exit` observed).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): run scripts in an isolated worker thread`.

### Task 4: Lazy local MCP pool

**Files:**

- Create: `src/main/codemode/mcp-pool/codemode-mcp-config.ts`, `src/main/codemode/mcp-pool/codemode-mcp-pool.ts`, `src/main/codemode/mcp-pool/codemode-mcp-content.ts`
- Create (test fixture): `src/main/codemode/mcp-pool/testing/fake-crm-mcp-server.ts` (stdio MCP server built with `McpServer` + `StdioServerTransport`; tools `find_user`, `update_user`, `add_to_group`, `add_credits`, in-memory state, plus `crash` that exits with stderr `boom` and `big` that returns 5 MB text)
- Test: `src/main/codemode/mcp-pool/codemode-mcp-pool.test.ts`, `src/main/codemode/mcp-pool/codemode-mcp-config.test.ts`

**Interfaces:**

- Produces:
  - `type CodemodeServerSpec = { name: string; command: string; args: string[]; env?: Record<string, string>; source: 'orca' | 'project' }`.
  - `readCodemodeServerSpecs(dir: string): Promise<CodemodeServerSpec[]>` — reads `<dir>/.orca/mcp.json` then `<dir>/.mcp.json` (`mcpServers` key; stdio entries only; first source wins a name clash; invalid JSON → that file is skipped and reported in `problems`). Return type is `{ specs: CodemodeServerSpec[]; problems: string[] }`.
  - `class CodemodeMcpPool { constructor(specs, opts: { cwd: string; env: NodeJS.ProcessEnv; approveStart: (spec) => Promise<boolean> }); names(): string[]; list(): { server: string; tools: string[] | null }[]; describe(server): Promise<{ name: string; description?: string; input_schema: unknown }[]>; call(server, tool, args, signal): Promise<string>; newTurn(): void; close(): Promise<void> }`.
  - `renderMcpContent(content: unknown[]): string` — text joined with `\n`; image/audio/resource → `[image <mime> <size>]` style placeholders.

Lazy start on first `describe`/`call`; `approveStart` is awaited before the first start (Task 7 wires it to the gate); refusal → error `start of server <name> was not approved`. A dead server restarts at most once per `newTurn()`; a second death returns `server <name> failed: <last 5 stderr lines>`. Uses `Client` + `StdioClientTransport` from the SDK with `stderr: 'pipe'`. Unknown server → `unknown MCP server <name>; known: a, b`.

- [ ] **Step 1: Failing tests:** config precedence + stdio-only filter + invalid JSON problem; `list()` before use shows `tools: null` and spawns nothing (assert no child process via the pool's started-count accessor); `describe` starts only that server; `call` round-trips `add_credits` state; `crash` → error contains `boom`, second crash in the same turn → no restart, message `server fake-crm failed:`; after `newTurn()` it restarts once; `close()` leaves no child processes; `renderMcpContent` placeholders.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): lazy per-session MCP pool for local servers`.

### Task 5: File tools and bash

**Files:**

- Create: `src/main/codemode/host/codemode-paths.ts`, `src/main/codemode/host/codemode-file-tools.ts`, `src/main/codemode/host/codemode-bash.ts`
- Test: `src/main/codemode/host/codemode-paths.test.ts`, `src/main/codemode/host/codemode-file-tools.test.ts`, `src/main/codemode/host/codemode-bash.test.ts`

**Interfaces:**

- Produces:
  - `resolveInRoot(root: string, input: string): Promise<{ path: string; inside: boolean }>` — resolves relative to `root`, follows symlinks of the deepest existing ancestor with `realpath`, `inside` is true only when the real path is `root` or below it (case-insensitive compare on win32/darwin is not assumed; compare realpaths).
  - `readFileTool({ path, offset?, limit? })`, `writeFileTool({ path, content })`, `editFileTool({ path, old_string, new_string })`, `grepTool({ pattern, path?, glob? })` (via `spawnBundledRipgrep` from `src/main/ripgrep/bundled-ripgrep-spawn.ts`), `findTool({ pattern, path? })` (via `rg --files -g`). Each takes `(input, ctx: { root: string })` and returns `Promise<HostReply>`.
  - `runBash(cmd: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; signal: AbortSignal; limits: CodemodeLimits }): Promise<{ exit_code: number; output: string }>`.

`edit` with 0 matches → `old_string not found`; >1 → `old_string matches N times; include more context`. `bash` timeout clamps to `bashMaxMs`; on timeout or abort the whole process group is killed and `exit_code` is `124` (timeout) or `130` (abort), output ends with `[timed out after Ns]` / `[interrupted]`.

- [ ] **Step 1: Failing tests:** paths — `../x`, absolute outside path, symlink inside root pointing outside → `inside: false`; nested new file under root → `inside: true`. Edit — 0, 1, 2 matches. Bash — `echo hi` → `{exit_code:0, output:'hi\n'}`; `exit 3` → 3; `sleep 30 & sleep 30; wait` with `timeoutMs: 300` → exit 124 and, after return, no process with that group remains (check with `process.kill(-pgid, 0)` throwing `ESRCH` on POSIX; skip on win32); 100 KB output → trimmed ≤ 30 KB + marker.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): sandbox file tools and bash with group kill`.

### Task 6: Gate

**Files:**

- Create: `src/main/codemode/gate/codemode-gate.ts`
- Test: `src/main/codemode/gate/codemode-gate.test.ts`

**Interfaces:**

- Produces:
  - `type GateCall = { kind: 'read' } | { kind: 'write' } | { kind: 'bash' } | { kind: 'mcp'; server: string; trusted: boolean } | { kind: 'mcp-start'; server: string } | { kind: 'path-outside' }`.
  - `type GateMode = AgentChatPermissionChoice | 'read-only'` (import `AgentChatPermissionChoice` from `src/shared/agent-launch/permissions/agent-chat-permission-mode.ts`).
  - `type GateDecision = 'allow' | 'ask' | 'ask-person-only' | 'refuse'`.
  - `decideGate(call: GateCall, mode: GateMode): GateDecision` — the spec 4.1 table (rows for `orca.*` and `lib.*` come in Parts C and D). `path-outside`: `ask`/`own` → refuse; other non-read-only modes → ask; read-only → refuse.

- [ ] **Step 1: Failing test:** one table-driven test whose expected matrix is copied verbatim from spec 4.1 (rows read, write, bash, mcp untrusted, mcp trusted, mcp-start) × modes (`own`, `ask`, `accept-edits`, `auto`, `full-access`, `read-only`), plus the `path-outside` row above.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): permission gate for inner calls`.

### Task 7: Run host

**Files:**

- Create: `src/main/codemode/host/codemode-run-host.ts`
- Test: `src/main/codemode/host/codemode-run-host.test.ts`

**Interfaces:**

- Consumes: Tasks 2–6.
- Produces:
  - `type Approver = (request: { title: string; detail: string; personOnly: boolean; signal: AbortSignal }) => Promise<'allow_once' | 'allow_session' | 'deny' | 'unsupported'>`.
  - `type InnerCallEvent = { runId: string; seq: number; tool: string; input: unknown; state: 'running' | 'ok' | 'error'; ms?: number; output?: string }`.
  - `class CodemodeSession { constructor(opts: { sessionId: string; root: string; env: NodeJS.ProcessEnv; mode: () => GateMode; trusted: (server: string) => boolean; approver: Approver; pool: CodemodeMcpPool; limits: CodemodeLimits; onEvent: (e: InnerCallEvent) => void }); run(code: string, signal: AbortSignal): Promise<{ text: string; isError: boolean }>; close(): Promise<void> }`.

`run` creates a `runId`, calls `pool.newTurn()`, builds a `ScriptHost` that maps each `HostCall` to a `GateCall` (`read/grep/find/mcp.list` → read; `write/edit` → write, or `path-outside` when `resolveInRoot` says outside; `bash` → bash; `mcp.call` → mcp with trust; `mcp.describe` → read but goes through `approveStart` for unstarted servers), applies `decideGate` with the **current** `mode()`, asks the approver for `ask`/`ask-person-only`, remembers `allow_session` per `server/tool` or per tool kind for the session, maps `deny` → `{ok:false,error:'denied by user'}`, `unsupported` → `{ok:false,error:'approval needed but this agent cannot show approval cards; switch the chat to full access or call the tool directly'}`, `refuse` → `{ok:false,error:'not allowed in this chat mode'}`. Emits `InnerCallEvent`s. Runs through `runScriptInWorker`, then `formatScriptResult`. Each `run` has its own budget and worker.

- [ ] **Step 1: Failing tests** (real pool with `fake-crm`, real temp dir, stub approver):
  - full-access: 4-step `fake-crm` script succeeds, no approver calls, events `running`→`ok` ×4 with increasing `seq`.
  - ask mode: approver called once for `mcp.call add_credits`; `deny` → script sees `denied by user` and state unchanged.
  - `allow_session` remembered: second call to the same tool does not ask.
  - mode switches mid-run: `mode()` returns `full-access` for the first call and `read-only` after → second call refused.
  - approver `unsupported` → the exact refusal text.
  - first start of `fake-crm` in ask mode asks with `personOnly: true`.
  - two concurrent `run`s on one session: separate `runId`s and separate call budgets (`maxCalls: 3`, each script makes 3 calls, both succeed).
  - Stop while an approval is pending: approver never resolves, abort the signal → `run` resolves within 1 s with `Interrupted by user` and the pending approval's `AbortSignal` (pass `signal` into the approver request as `signal: AbortSignal`) is aborted.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): run host with gate, approvals, and call events`.

### Task 8: Code-mode MCP server and tool description

**Files:**

- Create: `src/main/codemode/server/codemode-tokens.ts`, `src/main/codemode/server/codemode-http-server.ts`, `src/main/codemode/server/codemode-tool-description.ts`
- Test: `src/main/codemode/server/codemode-tokens.test.ts`, `src/main/codemode/server/codemode-http-server.test.ts`, `src/main/codemode/server/codemode-tool-description.test.ts`

**Interfaces:**

- Consumes: `CodemodeSession` (Task 7).
- Produces:
  - `class CodemodeTokens { issue(sessionId: string): string; resolve(token: string): string | null; revoke(sessionId: string): void }` — 32 random bytes hex, stored as SHA-256, compared with `timingSafeEqual`.
  - `buildToolDescription(input: { servers: string[] }): string`.
  - `class CodemodeHttpServer { start(): Promise<{ origin: string }>; register(sessionId: string, session: CodemodeSession, describeInput: () => { servers: string[] }): string /* token */; unregister(sessionId: string): Promise<void>; stop(): Promise<void> }`. Route `POST|GET|DELETE /codemode/mcp`. One SDK `McpServer` + `StreamableHTTPServerTransport` per (session, `mcp-session-id`). Tool `run_js` with input schema `{ code: string }` and `_meta: { 'anthropic/alwaysLoad': true }`. While running, send `notifications/progress` every `progressMs` when the request carries a `progressToken`. Client cancellation aborts the run. Approvals: the session's approver calls `server.server.elicitInput(...)` with message = title + detail and `requestedSchema = { type: 'object', properties: { decision: { type: 'string', title: 'Decision', enum: ['allow_once', 'allow_session', 'deny'], enumNames: ['Allow once', 'Allow for this session', 'Deny'] } }, required: ['decision'] }` and `_meta['anthropic/permissionDisplay'] = { title, displayName: 'Code mode', description: detail }`; `accept` + decision → that decision; `decline`/`cancel` → `deny`; client without the `elicitation` capability → `unsupported`.

Description text (keep under 150 words; values filled in):

```
Run JavaScript that calls tools. Use this for 3 or more tool calls instead of calling tools one by one.
Write the body of an async function: always `await` tool calls, never `.then`, and `return` the result.
Available: mcp.<server>.<tool>(args), mcp.list(), mcp.describe(server), read({path}), write({path,content}),
edit({path,old_string,new_string}), grep({pattern,path?,glob?}), find({pattern,path?}),
bash(cmd, {timeout?}) -> {exit_code, output}, print(...values).
MCP servers: <comma list or "none configured">.
Call mcp.describe(server) before using a server's tools for the first time.
```

- [ ] **Step 1: Failing tests:** tokens — issue/resolve/revoke, wrong token null, stored value is not the raw token. Description — contains "3 or more tool calls", "never `.then`", server list; ≤150 words with 3 servers. HTTP server (SDK `Client` + `StreamableHTTPClientTransport` against the real server with a stub session): no token → 401; `Origin` header → 403; wrong Host → 403; `tools/list` returns exactly `run_js` with `_meta['anthropic/alwaysLoad'] === true`; `tools/call run_js` returns the session's text; a run longer than `progressMs: 50` emits ≥1 progress notification; client with elicitation capability answers `allow_session` → approver result `allow_session`; client without the capability → `unsupported`; `unregister` makes the token fail.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): loopback MCP server exposing run_js`.

### Task 9: Injection into structured sessions

**Files:**

- Create: `src/main/codemode/codemode-service.ts` (owns one `CodemodeHttpServer`, creates `CodemodeSession`s, maps session id → session, closes on end)
- Modify: `src/main/bots/bot-launch-tools.ts` (add `static withExtraServers(base: BotLaunchTools, extra: BotToolServer[], env: Record<string,string>): BotLaunchTools` that preserves `relayed`/`NO_PROXY` behaviour and sets `relayed = true` when extra servers are loopback), `src/main/runtime/agent-session/launch/structured-agent-launch-composition.ts:211-215` (when `codemodeEnabled`, merge the code-mode server into `basis.toolServers()` output; pass `basis.permissionMode` and `record.sessionId`), the structured host assembly that receives `ended` events (`structured-agent-session-host-assembly.ts:39` / `deliverLifecycle`) to call `service.endSession(sessionId)`
- Modify: `src/main/acp/launch/acp-structured-launch-resolution.ts` (skip the `orca` server unless the agent's initialize response has `agentCapabilities.mcpCapabilities.http === true`; keep the existing `botToolsOff` skip)
- Test: `src/main/codemode/codemode-service.test.ts`

**Interfaces:**

- Consumes: Task 8.
- Produces: `CodemodeService.launchServer(input: { sessionId: string; root: string; env: NodeJS.ProcessEnv; mode: () => GateMode }): Promise<BotToolServer | null>` returning `{ name: 'orca', url: '<origin>/codemode/mcp', transport: 'http', headers: { authorization: 'Bearer <token>' } }` (Claude and Pi get the env-reference form `Bearer ${ORCA_CODEMODE_TOKEN}` with the token in env, like `ENV_REFERENCING_AGENTS` in `bot-launch-tools.ts:67`); `endSession(sessionId): Promise<void>`. If the server fails to start, `launchServer` returns `null` and logs once; the session launches without code mode.

`mode` reads the live session record's `permissionMode` each call (read-only sessions → `'read-only'`).

- [ ] **Step 1: Failing tests:** service — `launchServer` returns an `orca` http entry whose token authenticates; `endSession` revokes it (next request 401) and closes the pool (no child processes); server start failure → `null`. Launch config — with `codemodeEnabled` true the composed Claude `mcpServers`, Codex thread config (`mcp_servers.orca.url` and `.http_headers.authorization`), and Pi `ORCA_PI_BOT_TOOLS` each contain `orca`; with it false none do; an ACP agent without `mcpCapabilities.http` gets no `orca`. Use the existing launch-resolution tests in those folders as the harness (find them with `git ls-files '*launch-resolution*.test.ts'`).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(codemode): inject run_js into native chat sessions`.

### Task 10: Claude elicitation cards

**Files:**

- Modify: the Claude structured launch options (where `canUseTool` is registered: `src/main/claude/structured/permissions/claude-structured-inbound-control.ts:45` and `claude-prompt-registry.ts`) to pass `onElicitation`
- Create: `src/main/claude/structured/permissions/claude-elicitation-prompt.ts`
- Test: `src/main/claude/structured/permissions/claude-elicitation-prompt.test.ts`

**Interfaces:**

- Produces: `claudeElicitationPresentation(request: ElicitationRequest)` reusing `acpFormElicitationPresentation` from `src/main/acp/requests/acp-form-elicitation.ts` for `mode: 'form'`; `url` mode returns decline (out of scope). The handler registers a prompt the same way `canUseTool` prompts are registered, waits for the user's answer through the existing `answerPrompt` path, and returns `{ action: 'accept', content: { decision } }`, or `{ action: 'decline' }` on reject/cancel/session end.

- [ ] **Step 1: Failing test:** presentation of the Task 8 schema yields one non-skippable question with the three options in order; answering option 2 produces `{ action: 'accept', content: { decision: 'allow_session' } }`; cancel produces `{ action: 'decline' }`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(claude): show MCP form elicitations as native chat cards`.

### Task 11: Inner-call display

**Files:**

- Create: `src/main/codemode/runs/codemode-run-store.ts` (per session: `callId → runId` matches and the `InnerCallEvent` list; pushes updates to the renderer through the existing runtime event channel the native chat already subscribes to — find the channel used by `onSessionStatusChanged` and add a `codemode.runUpdated` event beside it)
- Create: `src/renderer/src/components/native-chat/tools/codemode/CodemodeRunView.tsx`, `src/renderer/src/components/native-chat/tools/codemode/codemode-run-rows.ts`, `src/renderer/src/components/native-chat/tools/codemode/CodemodeRunView.fixture.tsx`
- Modify: `src/renderer/src/components/native-chat/tools/runs/native-chat-tool-run-rows.ts` (new row kind `codemode` when `mcpToolIdentity(name)` is server `orca`, tool `run_js`, or Codex `name === 'orca/run_js'`), `NativeChatToolRunMemberList.tsx:57` (render it)
- Test: `src/main/codemode/runs/codemode-run-store.test.ts`

**Interfaces:**

- Produces: `matchRunToCall(session: { runningToolCalls: { callId: string; name: string; input: unknown }[] }, code: string): string | null` — returns the `callId` of the only running `run_js` call whose `input.code === code`; if two match, the earliest unmatched one.

UI per `docs/STYLEGUIDE.md`: collapsible code block, then one line per inner call `tool  ✓ 120ms` / `✗`, expandable to input and output. No unit tests for the component (repo rule); add a component fixture with running, finished, and failed states and screenshot it with `pnpm fixtures:shot <id>`.

- [ ] **Step 1: Failing test:** `matchRunToCall` — single match, no match → null, two identical codes → first then second.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement store, wire `InnerCallEvent` from `CodemodeService`, build the view and fixture. **Step 4:** Run — PASS; `pnpm fixtures:shot` the three states and look at the screenshots.
- [ ] **Step 5:** Commit `feat(codemode): show inner calls under run_js rows`.

### Task 12: Settings toggle

**Files:**

- Create: `src/renderer/src/components/settings/chat/CodemodeEnabledSetting.tsx`, `src/renderer/src/components/settings/chat/codemode-enabled-search.ts`
- Modify: `src/renderer/src/components/settings/chat/ChatSettingsSection.tsx:112`, `src/renderer/src/components/settings/navigation/settings-navigation-interface-sections.ts:63`, `src/renderer/src/i18n/locales/en.json` (beside `components.settings.nativeChat.*`) and the other locale files that carry `nativeChatInlineVisuals`

Copy `NativeChatInlineVisualsSetting.tsx`. Label "Code mode", description "Agents can run JavaScript that calls your MCP servers, files, and shell in one step. New chats only."

- [ ] **Step 1:** Implement. **Step 2:** `pnpm tc:web` passes. **Step 3:** Commit `feat(codemode): settings toggle`.

### Task 13: Proof

**Files:**

- Create: `tests/e2e/codemode/codemode-live.e2e.ts` (manual, needs the user's Claude/Codex login; skipped unless `ORCA_CODEMODE_LIVE=1`), reusing the `fake-crm` server from Task 4 configured in a temp worktree's `.orca/mcp.json`
- Create: `src/main/codemode/codemode-end-to-end.test.ts` — headless integration: real `CodemodeService` + real HTTP server + SDK `Client` acting as the agent (with elicitation capability), real `fake-crm`

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Headless integration tests:** full-access script runs the 4-step `fake-crm` task in one `run_js` and the final state is `{ name: 'Bob', groups: ['Team A'], credits: 10 }`; ask mode with the client answering `deny` on `add_credits` leaves credits at 0 and the result text contains `denied by user`; `tools/list` contains only `run_js` (no `fake-crm` schemas); token usage check — the `tools/list` payload size with code mode vs. the size of `fake-crm`'s own `tools/list` ×5 servers, logged.
- [ ] **Step 2:** Run — PASS.
- [ ] **Step 3: Live test:** launch Orca headless with `ORCA_BACKGROUND_LAUNCH=1`, `codemodeEnabled: true`, create a native Claude chat in the temp worktree, send "Using the fake-crm MCP server: find x@y.com, rename to Bob, add to Team A, add 10 credits." Assert via the session journal: ≥1 `run_js` tool call, no direct `fake-crm` tool calls, final `fake-crm` state as above. Repeat with Codex if logged in. Capture a CDP screenshot of the `run_js` row.
- [ ] **Step 4:** `pnpm check:changed` — Expected: no failures.
- [ ] **Step 5:** Commit `test(codemode): end-to-end proof for run_js`.
