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
| Cursor | SDK 1.4.1 | SDK create or resume | Refused in both execution modes. Earlier SDK 1.3.1 evidence covers delivery and local storage. Current credential isolation remains unverified. |
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
| Antigravity and DSH | 1.5.11 and 0.2.1-rc.5 | Credential-free entries | Both already refuse credentials. |
| Pi Durable, Cybion and Morph | Adapter declarations | No per-session attachment | All three already refuse session MCP servers. |

Hosts using `serveMcpTools` supply a bearer header on every entry. Managed
MCP tools therefore cannot attach on Cursor, Devin, Pi RPC or Windows Claude
with these refusals. Check the installed runtime's refusal declaration before
opening the session. [Admission contract](../../docs/spec/runtime-matrix.md#refused-session-options)

“Passed” means both recipients received their value, the ordinary tool
reported neither, and neither value was observed in the file or command-line
samples. The [counts](samples.json) are from the pre-refusal implementation.
The CodeBuddy ordinary-tool receipt came from a second run after the first
shell command could not start. The [refusal tests](../../tests/refused-session-options.test.ts)
check that public declarations agree with session admission. Empty environment
and header maps remain usable.
