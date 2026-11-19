# OpenCode 2.x session prompts

Does OpenCode 2.x apply a session-local `OPENCODE_CONFIG_CONTENT` that sets
`agents.<id>.system` and adds one file to `instructions`, and can the
session's agents be listed without the shared background service?

[native.ts](native.ts) sets the overlay directly on each release and reads
the system message of the next provider request from a loopback provider
([aimock harness](../../sea-trial/harness/aimock-acp.ts)). It also runs
`debug agents --standalone` with the same environment. [oar.ts](oar.ts)
goes through OAR's `systemPrompt` and `appendSystemPrompt` on a new session
and its resume, with the default configuration and with a custom default
agent (`review`) plus a disabled `plan`. Linux x64, 2026-11-19, no account
and no real provider.

| Release | System marker | Instructions marker | Native prompt replaced | `debug agents --standalone` |
| --- | --- | --- | --- | --- |
| 2.0.0 | yes | no | yes | unrecognized flag |
| 2.0.22, 2.0.25, 2.0.27, 2.0.29 | yes | no | yes | unrecognized flag |
| 2.0.30, 2.0.31, 2.0.32 | yes | yes | yes | unrecognized flag |
| 2.1.0, 2.1.4 | yes | yes | yes | unrecognized flag |
| 2.2.0, 2.2.7 | yes | yes | yes | `build`, `plan` |
| 2.3.2 | yes | yes | yes | `build`, `plan` |

The v1-shaped overlay (`agent.<id>.prompt`) gave the same result on 2.0.0,
2.0.22, 2.1.0, 2.2.0 and 2.2.7: 2.x migrates it. OAR writes the v2 fields.

Without `--standalone`, `debug agents` on 2.3.2 connected to the machine's
running background service (another process's port), so its answer would
not reflect the session's environment.

Through OAR on 2.3.2 (and on 2.2.7 in the vendor test):

| Case | New session | Resume with a new `systemPrompt` |
| --- | --- | --- |
| Default configuration | replacement and append present, native prompt absent | new replacement present, old one absent |
| Custom default `review`, `plan` disabled | replacement present, the agent's own `system` absent | same |

On resume, OpenCode sends the earlier system text again and adds a user
`<system-update>`: with no `appendSystemPrompt`, "Previously loaded
instructions no longer apply."; with one, "The instructions from <old
file> no longer apply. New instructions apply from: ..." followed by the
new file's text, the same text included. Instructions are keyed by path.

Reproduce: `OAR_OPENCODE_BIN=<binary> pnpm tsx experiments/opencode-v2-prompts/native.ts v2`
(or `v1` for the legacy shape), and `... oar.ts default|custom`.
Regression: the `systemPrompt and appendSystemPrompt` case in
[opencode-cleanup.vendor.test.ts](../../sea-trial/vendor/opencode-cleanup.vendor.test.ts).
