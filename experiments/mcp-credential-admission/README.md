# Session MCP credential isolation

On 2026-11-20, two synthetic values were supplied to each available pinned
Linux runtime through a stdio entry's environment and an HTTP entry's
Authorization header. Each designated local server confirmed receipt. A
scripted model invoked an ordinary shell tool which checked whether either
fixture value reached its environment. No real account was used.

The file checks covered regular files in the isolated home, configuration,
data, state, cache, working and temporary directories. They compared the
literal values in UTF-8 and UTF-16LE after open, after the turn and after
dispose. Command-line checks sampled the test's own process tree after open
and after the turn. Short-lived processes between samples, other encodings,
remote storage and native behavior on other operating systems were outside
these measurements. Installation versions follow the [CI pins](../../.github/runtime-versions.json)
and the [bundled SDK dependencies](../../packages/oar/package.json).

| Runtime | Version | OAR delivery | Observation and admission |
| --- | --- | --- | --- |
| Claude | 2.1.326 | Startup FIFO | Linux passed. Windows declares credentials refused. POSIX refuses the open if it cannot create the FIFO. |
| CodeBuddy | 2.179.3 | ACP session request | Passed. A separate ordinary-tool control used a directly executable fixture in the session directory. |
| Codex | 0.169.0 | App-server thread configuration | Passed on isolated open. |
| Cursor | SDK 1.4.1 | SDK create or resume | Passed on Linux x64 (2026-11-26, `gpt-5.4-nano`, direct `in_process` SDK call; `subprocess` passes `mcpServers` over Node IPC rather than argv/env and redacts child stderr before tail truncation): both stdio `env` and loopback HTTP `Authorization` reached the echo servers; ordinary shell `env`, stream events, process-tree `/proc/<pid>/{cmdline,environ}` (outside the stdio server's own `environ`) and isolated `HOME`/`TMPDIR`/workspace files (`agent-transcripts/*.jsonl`, `store.db`/`-wal`, `index.db`/`-wal`) held neither canary (plain or base64). |
| Devin | No CI pin | ACP session request | Refused. Earlier evidence covers its SQLite store alone. |
| Factory | 1.12.1 | Native session request | Passed. |
| Grok | 1.0.70 | ACP session request | Passed. |
| Kimi | 2.6.3 | ACP session request | Passed on a fresh session. |
| OpenCode v1 | 1.19.5 | ACP session request | Passed. |
| OpenCode v2 | 2.2.7 | ACP session request | Passed. |
| Pi in process | 1.5.2 | SDK extension registration | Passed. |
| Pi RPC | 1.5.2 | Process configuration | Both values were present in one file at open and after the turn. Disposal removed it. RPC now refuses credentialed entries before launch. |
| Qoder | 1.1.81 | Startup FIFO on Linux | Passed. The file fallback is released after native initialization. |
| Qwen | 0.27.4 | ACP session request | Passed. |
| Antigravity and DSH | 1.5.11 and 0.2.1-rc.5 | Credential-free entries | Both refused credentials at the time. See the DSH follow-up below. |
| Pi Durable, Cybion and Morph | Adapter declarations | No per-session attachment | All three already refuse session MCP servers. |

Hosts using `serveMcpTools` supply a bearer header on every entry. Managed
MCP tools therefore cannot attach on Antigravity or Devin
with these refusals. Check the installed runtime's refusal declaration before
opening the session. [Admission contract](../../docs/spec/runtime-matrix.md#refused-session-options)

“Passed” means both recipients received their value, the ordinary tool
reported neither, and neither value was observed in the file or command-line
samples. The [counts](samples.json) are from the pre-refusal implementation.
The CodeBuddy ordinary-tool receipt came from a second run after the first
shell command could not start. The [refusal tests](../../tests/refused-session-options.test.ts)
check that public declarations agree with session admission. Empty environment
and header maps remain usable.

## DSH bridge stdin

On November 24, 2026, Linux probes used separate synthetic credentials on
`0.2.1-rc.5` and `0.2.2-rc.5`. The bridge mounted both native plugins in
memory. On both versions, a local stdio tool and a loopback HTTP tool
returned the expected results on the first turn. A separate check found no HTTP
marker in the stdio server environment and no stdio marker in the HTTP
request headers. The ordinary shell received
neither credential. UTF-8 and UTF-16LE scans of the isolated directories
(including the launch patch and native session history) found neither value
after open, after the turn or after disposal. Both argv samples, OAR records
and scripted provider requests were also clean. The file and process sampling
limits above apply.

A missing stdio executable and an HTTP 503 at initialization each refused
open. An HTTP 503 during a tool call produced a tool error after successful
initialization. A test-only Cordis exporter inspected the logger arguments
during these cases, including error objects and their causes. On
`0.2.2-rc.5`, the plugin also calls `ctx.logger.warn(error)` when a connection
status listener throws. An ordinary stdio disconnect exercised that branch
with a listener throwing a fixed test error. It logged the listener's error.
Neither marker appeared in the captured arguments. OAR installs no such
listener. The test servers returned fixed errors and kept their credentials
out of tool output.

[Sample counts](dsh-bridge.json) and the [served-tool regression](../../sea-trial/vendor/dsh-mcp-credentials.vendor.test.ts)
cover the two transports. The regression uses OAR's own `serveMcpTools`
server with its generated bearer header.
