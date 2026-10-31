# Windows isolated tool cleanup

Runtime version check: 2026-10-31

OpenCode 2.2.3 on Windows x64 left a running tool and its child behind when
an isolated session was disposed during that tool call. This was reproduced
on main product code, without the proposed shared adapter:
[run 41168214310](https://github.com/botiverse/oar/actions/runs/41168214310),
[test-only commit 53a6a5e](https://github.com/botiverse/oar/commit/53a6a5e).
Its product base was `e565d5f`; `packages/` was unchanged. The artifact
`opencode-cleanup-baseline-windows` (ID `13029568180`) retains process start
identities, native exit facts, session records and the original failed
`[true, true]` versus `[false, false]` liveness assertion. The temporary
manual workflow is not part of this change.

Before disposal, the observed chain was OpenCode 7980, OpenCode 6796,
PowerShell 3416, tool 7192, and child 4960. At 04:22:18.980Z the OpenCode and
PowerShell ancestors were gone; the tool, child and shell's conhost 3540
remained. At 04:22:34.637Z all three still had the same start identities.
Both runtime roots reported exit code 0. These observations establish an
existing isolated-path leak. They do not by themselves establish taskkill's
internal traversal order.

A deterministic fixture supplies the relevant ordering directly: an
intermediate parent starts an independent tool, reports readiness, then exits
when the runtime receives cancellation. The tool survives until OAR reclaims
its captured identity. Normal Windows `killTree` shutdown now captures before
EOF/taskkill; isolated ACP disposal captures before its existing native
cancel/close operations, which can sever the parent chain even earlier.
Fresh identity matching, bounded read retries and unverified-cleanup reporting
reuse the existing cleanup mechanism. Failed reads never authorize signalling
an unverified remembered PID.

This adds Windows shutdown latency: capture completes before cancellation or
EOF, and remembered descendants require a fresh read after native exit. Each
CIM query keeps its five-second deadline; capture retries once only while the
owned root remains alive. Concurrent reads follow the existing fresh-batch
rule. They are asynchronous and do not block the host event loop. A native
startup failure can exit during capture and report `missing_root`; the original
native error remains intact, with the cleanup diagnostic appended.

Release-note impact: Windows CIM reads can take hundreds of milliseconds,
so runtimes that fail immediately at startup often exit before the first
capture completes. Their original startup error type and native cause remain
unchanged, but the error message may frequently append `before_eof windows:
missing_root` to report that descendant cleanup could not be verified. This
is an intentional diagnostic change as well as the isolated tool cleanup fix.

`tests/process-orphan-cleanup.test.ts` covers a real orphan, duplicate
preparation, an unreadable table, and ordinary tree shutdown.
`tests/acp/acp-orphan-cleanup.test.ts` exercises the Windows public ACP disposal
path against the real cancellation fixture. Existing process-cleanup and
shutdown-order tests cover PID reuse, root exit during capture/force, and
non-overlapping cleanup phases.

The original native isolated scenario runs with:

```sh
OAR_TEST=opencode-cleanup pnpm vitest run sea-trial/vendor/opencode-cleanup.vendor.test.ts
```

Install `@opencode/cli@2.2.3` or set `OAR_OPENCODE_BIN` to that executable.
It uses an isolated HOME, local model responses and local MCP servers, without
an account. Two independent sessions test tool cleanup and the surviving
peer, then resume the disposed session. Both tool processes must be ready and
alive before disposal. The final fixture fallback fails the test if it has to
kill any unasserted residual process, including MCP or conhost processes.
Secondary sampling errors are retained separately and cannot bypass the
original lifecycle assertion. The check matrix runs this scenario on Linux,
macOS and Windows and uploads its evidence even on failure.

Discarding the captured descendant list in a temporary fault injection made
the real orphan test fail its tool-liveness assertion; the product code was
restored afterwards.

Local Linux x64 validation passed the native isolated scenario and left no
processes for fixture reclamation. Linux does not validate Windows CIM or
Windows native termination; those results belong to the fix commit's CI.

The fix at `a83abd0` passed that native scenario on all three CI platforms in
[run 41169414228](https://github.com/botiverse/oar/actions/runs/41169414228).
The `opencode-cleanup-{ubuntu,macos,windows}-latest` artifacts retain each
process tree and shutdown diagnosis. On Windows, all three runtime roots
reported exit code 0 and observed cleanup; capture took 388 to 441 ms and
post-exit revalidation took 415 to 434 ms. Both tool-liveness assertions and
the final residual-process check passed. This is evidence for that isolated
scenario, not for the proposed shared adapter or every native shutdown path.
