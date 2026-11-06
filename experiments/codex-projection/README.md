# Codex message and MCP projection

Checked on Linux x64, 2026-11-06, with Codex 0.167.0 and a scripted loopback
provider. No account or remote model was used. Task #171 covers completed-only
assistant text, native message phase, separate MCP names and the declared
`unauthorized` error tag.

## Native controls

| Control | Native report | Before | After |
|---|---|---|---|
| Drop every provider `response.output_text.delta`, keep completed output | `item/completed` has `agentMessage.text: "COMPLETE_TEXT"`; no app-server text delta | no projected text | one `text_delta` on that completion frame |
| Keep provider text deltas | one app-server text delta, then completed full text | text once | text once, no completion duplicate |
| Provider message phase `final_answer` | native started and completed items carry that phase; deltas do not | phase omitted | same item's phase preserved on text events |
| Stdio and HTTP MCP echo, then resume | `mcpToolCall.server` is `echo` or `remote`, `tool` is `echo` | names only in native frame | separate `server` and `toolName` on `tool_call_started`; `tool` remains `mcpToolCall` |
| Provider SSE failure with code `unauthorized` | native `codexErrorInfo: "other"`, reason describes disconnected stream | `unknown` | `unknown`; no inference from the word |

The first two vendor assertions were run before the product change and failed:
missing completed text, and missing phase. Both now pass on the real CLI.
`promptAndWait` returns `COMPLETE_TEXT` exactly once in both successful controls.
The MCP check asserts projected names against actual native frames on open and
resume, in addition to checking the server's tool result reached the model.

The two new [raw message fixtures](../../tests/replay/fixtures/codex-message-completed-only.raw.jsonl)
and [streamed control](../../tests/replay/fixtures/codex-message-streamed.raw.jsonl)
retain selected native notifications, with thread, turn and item identities
normalized. Their adjacent `metadata.json` snapshots pin the full text event,
not just its kind. The existing MCP raw fixture also has a new metadata
snapshot. The existing subagent projection snapshot changes on three completion
rows: two root messages and one child message already contained text. That
older fixture was trimmed to selected fields, has no deltas anywhere and omits
turn ids. It cannot establish that real Codex omitted deltas for those messages;
this is a snapshot change only. No fixture text was invented or replaced.

## Error evidence boundary

The exact string `codexErrorInfo: "unauthorized"` is in the protocol generated
by the installed 0.167.0 CLI. OAR maps this explicit tag to `auth`, with neither
`status` nor `credential` invented. This is a source-backed mapping, not a
claim that a real account failure emitted the tag. The local SSE control above
does not emit it. Existing HTTP 401 controls emit a different native transport
variant and continue to classify by the reported HTTP status.

Generated source hashes (SHA-256):

| File | SHA-256 |
|---|---|
| `v2/CodexErrorInfo.ts` | `288b1dcae273c89677eef35fdd70d7645643e500614e505cda29f683d36a1935` |
| `v2/ThreadItem.ts` | `3cb8211f7a24818527d5b9f2d77b1e606bcd164959f821f162611f7497a7d605` |
| `v2/AgentMessageDeltaNotification.ts` | `bb538862f093bd22278bea3b3343037525a9218fbddef534e37e048347c10805` |

`ThreadItem` declares `agentMessage.phase` and separate MCP server/tool names;
`AgentMessageDeltaNotification` has no phase. Unknown future string phases are
preserved. Missing or null phase stays absent. Error text is not a substitute
for the structured tag, and inherited object properties are not error tags.

## Reproduce

Select a local Codex 0.167.0 executable with `OAR_CODEX_BIN`, then from the repo:

```sh
pnpm exec tsx experiments/codex-projection/probe.ts
"$OAR_CODEX_BIN" app-server generate-ts --experimental --out /tmp/codex-projection-schema
OAR_TEST=codex-aimock OAR_TEST_REQUIRE_AVAILABLE=1 pnpm vitest run sea-trial/vendor/codex-messages.vendor.test.ts sea-trial/vendor/mcp-servers.vendor.test.ts
pnpm vitest run tests/codex/codex-message-projection.test.ts tests/codex/codex-item-detail.test.ts tests/failure-mapping.test.ts tests/event-phase.test.ts tests/replay/codex-metadata.test.ts
```

The probe uses the same provider rewrite as the vendor regression: it removes
only text-delta SSE events, leaving completed provider output intact. It prints
selected native frames and projected events, plus the public wait result.

## Host-visible changes

- Completed-only Codex assistant messages now appear in text subscriptions and
  turn results. Streamed text is not repeated at completion. If some text did
  stream but differs from the final body, OAR does not guess a missing suffix.
- `text_delta.phase`, `tool_call_started.server` and `toolName` are optional
  native metadata. Existing event fields and native frames retain their meaning.
- Coalescing keeps different native phases apart, including absent versus
  present. A phase learned at completion does not rewrite earlier events.
- An explicit native `unauthorized` tag now yields `failure: "auth"`; unknown
  tags and errors described only in prose retain their existing fallback.

The projection keeps message evidence per native thread, turn and item. Tests
cover child/root interleaving, separate turns, empty and partial deltas,
duplicate completion, absent/unknown phases, and exact source-frame ownership.
Windows and macOS native validation belongs to the PR's CI; local evidence here
is Linux only.

## Validation

Linux: full check passes (3,559 unit tests and 18 mock behavior cases), all
75 Codex 0.167.0 vendor cases pass, and all 15 configured behavior backends
pass. Eleven isolated reversions of the new behavior each fail a regression:
completion fallback, streamed/repeated completion suppression, phase learning,
thread/turn isolation, empty deltas, phase coalescing, each MCP name and the
unauthorized mapping. Existing unsupported-capability cases remain skipped.

Build and clean packed-package consumption also pass. The full check and Codex
vendor suite were repeated after integrating the native retry projection from
PR #647; both message and retry evidence remain in the projection state.

Review note: message evidence is cleared at `turn/completed`. A hypothetical
late `item/completed` after that boundary could repeat previously streamed text.
No native example of that ordering was established in this change, including
on abort; the normal native ordering is not a promise about unobserved paths.
