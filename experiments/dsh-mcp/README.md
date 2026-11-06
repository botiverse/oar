# DSH session MCP command and args

Issue #646, task #184. Linux x64, 2026-11-06, real DSH with a scripted loopback
model. No account, remote model or ACP exchange is involved.

The existing OAR-owned DSH process can load native `dsh-mcp-client` plugins
through its invocation patch. An initial probe attached an echo server through
a native profile row, then the session option used the same native loader in
OAR's private invocation patch. The bridge JS still imports no DSH package;
DSH resolves its own plugin. No bundled DSH dependency was added.

## Controls

| Control | Observed result |
|---|---|
| Model calls `mcp__echo__echo` | Native tool result `echo:FIRST via=stdio token=none` reaches the next model request; OAR records the native call and successful result |
| Command with spaced, shell-looking and empty arguments | Child receives the literal arguments, in the session working directory |
| Two simultaneous OAR sessions with different entries, plus one with none | Each model sees only its own entry plus the unchanged user-configured MCP server |
| Resume with another entry | Same native session id/history; only the new entry and user's configured server are offered |
| Resume without entries | Previous tool results remain in history; previous session MCP tools are not offered |
| Dispose | The tracked MCP child is no longer alive after disposal |
| One healthy server plus a nonexistent command | Open fails before any model request, and the already-started child is cleaned up |
| Native namespace collision with a configured server | Open fails with the native duplicate-name error; user's patch is unchanged |
| HTTP, nonempty env/headers, incompatible or reserved name | Typed `UnsupportedOptionError` on `mcpServers` before executable launch |
| Loader cannot confirm activation | Missing method or native pending state refuses open instead of running without the tool |

The first failure controls found a real gap in the initial implementation:
`loader.await()` waits with `Promise.allSettled`, so a failed MCP plugin did not
prevent opening. The bridge now locates each requested row using the native
loader's recursive `entries()`, awaits that fiber and requires its native
ACTIVE state (Cordis `FiberState.ACTIVE = 2`). Those startup-failure controls
failed before this check and pass with it. Failure is not classified from
stderr text. The normal loader inventory remains the first successful frame.

The user's patch stays byte-for-byte identical. DSH still creates ordinary
profile files and writes session logs and caches. This is not a claim that
`DSH_HOME` is untouched, nor an audit of credentials persisted by DSH. HTTP and
nonempty MCP env/headers remain refused. Persistence of command/args has not
been audited either. Do not move tokens into `args`; this path is not a
credential transport.

## Reproduce

Set `OAR_DSH_BIN` to the chosen DSH executable, then from the repository:

```sh
pnpm exec tsx experiments/dsh-mcp/probe.ts
OAR_TEST=dsh-aimock OAR_TEST_REQUIRE_AVAILABLE=1 pnpm vitest run sea-trial/vendor/dsh-mcp.vendor.test.ts
pnpm vitest run tests/dsh/mcp.test.ts tests/refused-session-options.test.ts
```

The probe prints only selected native tool results, model tool names and
outcomes. The vendor suite additionally checks actual child identities,
arguments, cwd, concurrent sessions, failures and unchanged user configuration.
Selected probe results are [0.2.1-rc.5](0.2.1-rc.5.json) and
[0.2.2-rc.1](0.2.2-rc.1.json); package-manager bootstrap output is omitted. Windows and macOS results
remain subject to this PR's CI, not inferred from Linux.

## Validation

Linux full check after rebasing over #648 passes: 3,568 unit tests and 18 mock behavior cases. Each of
DSH 0.2.1-rc.5 (CI floor) and 0.2.2-rc.1 (npm latest on this date) passes all
21 native vendor cases and 18 behavior cases, with one capability skip. Build
and clean packed-package consumption pass. No broader version range is claimed
as measured. Existing version-floor detection stays unchanged.
