# Native child working directory and environment

Runtime version check: 2026-10-31.

**Grok 1.0.70 is not admitted to sharing.** Actual stdio MCP processes start
in the ACP process HOME under sharing and the session directory under
isolation. Both session-supplied and user-configured MCP reproduce it.
An empty or HTTP-only session MCP list cannot rule out native configuration,
so the production gate refuses every version/platform: `auto` opens an
isolated process and explicit `shared` fails with option `placement`.

OpenCode 2.2.3/2.2.5 stdio MCP and ordinary tools use the session directory,
but configured plugin children inherit the ACP process cwd. That separate
[counterexample and admission withdrawal](opencode-plugin-environment-2026-10-31.md)
is handled by PR #587. No native runtime is currently enabled for sharing.

## Native controls

A local Linux x64 host, Node 24.19.0, exact native executables and local
scripted model providers ran 24 cohorts. Each runtime/version has four stdio
MCP controls (session/user source by shared/isolated) and four actual hook
controls (user/project configuration by shared/isolated). Every cohort opens
two different directories. Temporary homes, configuration and endpoints
are disposable; no real account is used.

| Native version | Child source | Shared cwd | Isolated cwd | Synthetic environment marker |
| --- | --- | --- | --- | --- |
| Grok 1.0.70 | Session stdio MCP | Process HOME | Session A/B | Inherited |
| Grok 1.0.70 | User-configured stdio MCP | Process HOME | Session A/B | Inherited |
| Grok 1.0.70 | User/project command hooks | Session A/B | Session A/B | Inherited |
| Grok 1.0.70 | Scripted terminal tools | Session A/B | Session A/B | Inherited |
| OpenCode 2.2.3 and 2.2.5 | Session and user-configured stdio MCP | Session A/B | Session A/B | Inherited |
| OpenCode 2.2.3 and 2.2.5 | User/project plugin child | Process HOME | Session A/B | Inherited |
| OpenCode 2.2.3 and 2.2.5 | Scripted terminal tools | Session A/B | Session A/B | Inherited |

The MCP server logs its own `process.cwd()` and environment marker at
startup. Both A and B actually invoke its echo tool; the full call journal
must equal exactly those two invocations, including the intended server
identity. This proves the server started and was used, rather than reading a
configuration path or relying on absence of errors. The first terminal turn
also lets OpenCode finish asynchronous MCP catalog discovery before the
explicit MCP call. Neither a timeout increase nor a product warm-up is added.

Grok's user configuration writes `[mcp_servers.scope]` in disposable
`GROK_HOME/config.toml`; OpenCode writes a local MCP entry to disposable
`XDG_CONFIG_HOME/opencode/opencode.json`. Session MCP options are empty in
those controls. The actual commands and script paths are absolute; cwd
still differs for Grok, so rejecting only relative command/argument strings
would be insufficient. The raw native controls intentionally bypass
production refusal to observe the reason for that refusal.

Grok PreToolUse hooks report their actual child cwd and marker. Each hook's
native session id is checked against the session that OAR opened, and both
session directories must appear. OpenCode's native `execute.before` callback
uses Node's `execFileSync` without cwd/env overrides; its child reports its
own cwd and marker. The plugin's location remains correct while the actual
child cwd differs. Tool scripts also log cwd and marker from inside the
executing child, not from an ACP request parameter.

The [selected evidence](selected-execution-environment-2026-10-31.json)
retains every startup, hook child and tool execution, full MCP calls, errors,
exact version and platform. Directory names become `session_A`, `session_B`
and `process_HOME`. Selection does not turn a difference into a pass.

## Reproduction and admission limits

Choose exact `OAR_GROK_BIN` or `OAR_OPENCODE_BIN`, then run:

```sh
pnpm tsx experiments/sharing/execution-environment.ts grok
pnpm tsx experiments/sharing/execution-environment.ts opencode
```

All three tested runtime/version commands exit **1** with a comparison that
identifies the known mismatch: two Grok MCP source failures or two OpenCode
plugin scope failures. Individual cohorts complete without probe errors.
Missing observations also fail. Results are retained below
`oar-trial-run/execution-environment/<runtime>` even when comparison fails.

The manual `shared-runtime-evidence.yml` has an
`execution_environment_only` input for `grok`/`opencode`, and an exact
`opencode_version` choice of 2.2.3 or 2.2.5. It also collects these controls
during full and directory-focused runs. The workflow is read-only and the
new step depends on successful installation, not earlier evidence success.
The job limit is 80 minutes to accommodate the additional bounded step.
There is no automatic runtime admission or bypass of product refusal.

Rebuild the selected data from raw output directories named
`execution-environment-opencode-2.2.3`,
`execution-environment-opencode-2.2.5` and
`execution-environment-grok-1.0.70`:

```sh
python3 experiments/sharing/select-execution-environment.py RAW_ROOT
```

These new results are Linux x64 observations. macOS/Windows are not inferred
from them. The version-wide refusal follows the reviewed rule for configured
behavior that cannot be identified before opening a session; it is not a
claim that a Windows or macOS probe reproduced the difference. Future
admission requires this evidence on every proposed platform. The marker
checks one synthetic inherited variable, not every possible environment key.
The user-file controls do not claim to enumerate all native plugin or project
MCP discovery paths; one hidden configuration source already defeats an
options-only guard.
