# Codex structured quota errors

Codex 0.169.0 and 0.169.1 on Linux x64 preserves a provider's HTTP-400 JSON error body,
but discards the same error's structure in a streamed `response.failed`.
Remote compaction also omits the failure response's rate-limit update.
All observations below use isolated synthetic homes and loopback servers;
no real account, external model request, or quota exhaustion was involved.

## Controls

The provider error is:

```json
{"error":{"type":"usage_limit_reached","code":"usage_limit_reached","message":"You've hit your usage limit. Try again at 9:00 PM.","plan_type":"pro","resets_at":1900000000,"limit_window_minutes":300}}
```

For streaming, that inner error object is `response.error` in the
`response.failed` event. Header controls supply
`x-codex-primary-used-percent: 100`, `x-codex-primary-window-minutes: 300`,
and `x-codex-primary-reset-at: 1900000000`. A successful seed turn instead
supplies 25% and `1899996400`, making a stale snapshot distinguishable.

| Path and response | Native `codexErrorInfo` | Native error message | Latest rate-limit notification |
|---|---|---|---|
| Normal HTTP 429, no headers | `usageLimitExceeded` | Native usage-limit sentence, reset rendered in local time | No window |
| Normal HTTP 429, headers | `usageLimitExceeded` | Same native sentence | 100%, `1900000000` |
| Normal streamed failure, no headers | `other` | Stream-disconnected prefix plus supplied sentence, no JSON | No window |
| Normal streamed failure, headers | `other` | Same plain text | 100%, `1900000000` |
| Compact HTTP 429, no headers | `usageLimitExceeded` | Remote-compaction prefix plus native sentence | No window |
| Compact HTTP 429, headers | `usageLimitExceeded` | Same plain text | Stale seed: 25%, `1899996400` |
| Compact streamed failure, no headers | `other` | Remote-compaction and stream-disconnected prefixes plus sentence | No window |
| Compact streamed failure, headers | `other` | Same plain text | Stale seed: 25%, `1899996400` |
| Normal HTTP 400, with/without headers | `other` | Complete provider JSON body | No window |
| Compact HTTP 400, with/without headers | `other` | `Error running remote compact task: ` followed by complete provider JSON | Seed window only when supplied |

`error.error` and the failed `turn/completed.turn.error` agree in every
control. Both contain `message`, `codexErrorInfo`, `additionalDetails: null`
and `misalignment: null`; neither has a structured reset outside the
preserved HTTP-400 body. The sixteen controls per version and their selected native
frames are in [selected.json](selected.json).

Four rows per version in that file use a synthetic ChatGPT account and a
separate usage endpoint. For normal/compact and HTTP-429/streamed failures,
`account/rateLimits/read` returns 25% / `1899996400` before failure and
100% / `1900000000` afterward. The backend changes only when it serves the
refusal. Thus a fresh read obtains the new window even when compaction's
notification is stale. This tests native HTTP decoding and OAR's usage
projection; it does not prove that every real account reports exhaustion
immediately, or that a full window caused an arbitrary failed request.

## OAR mapping

The HTTP-400 body supplies the failure category through `error.type` or
`error.code`, and the absolute reset through numeric `error.resets_at`
(Unix seconds). OAR removes only the observed native remote-compaction
prefix before parsing the complete JSON body. It preserves the original
reason. Invalid or absent reset fields remain absent.

Streamed usage-limit failures stay `unknown`; OAR does not classify the
English sentence or parse its local time. Named `usageLimitExceeded`
continues to mean `quota`. Its error has no reset field, but the normal
HTTP-429 path emits a `limitId: codex` account notification before failure.
OAR reads its exhausted primary/secondary windows only during the current
observed root turn. It attaches a reset only when every exhausted window
has the same valid reset. Missing or conflicting resets remain absent.

OAR owns one app-server per session, but these account notifications have
no thread or turn ID. The projection clears them at turn boundaries and
when compaction starts, freezes the snapshot at the terminal error, and
disables attribution for the session once another thread or collaboration
item appears. Child-thread failures never borrow the root snapshot. A
full window cannot classify an `other` error. Remote compaction's dropped
update therefore supplies no reset; hosts can read `accountUsage()` after
a failure and decide using its separately reported windows.

[Replay controls](../../tests/codex/quota-errors.test.ts) exercise the actual
projection with all recorded error and rate-limit notifications, the four
live-read responses through the account-usage projection, and malformed
body/reset controls. Separate tests cover prior turns, idle/late updates,
compaction, child activity, mismatched turn IDs and conflicting windows.
The CI pin 0.169.0 and production-range endpoint 0.169.1 agree in all sixteen
controls. Other versions in the reported production range were not tested.

## Reproduce

Install the repository dependencies and an isolated `@openai/codex@0.169.0`,
then run from the repository root:

```sh
OAR_CODEX_BIN=/absolute/path/to/codex pnpm exec tsx experiments/codex-quota-errors/probe.ts oar-trial-run/codex-quota-errors.json
pnpm exec vitest run tests/codex/quota-errors.test.ts
```

The probe retains synthetic homes under the system temporary directory and
writes full request/notification evidence locally. It clears inherited
environment values, supplies only synthetic credentials, and points the
provider and account backend at loopback. Remote compaction uses a custom
provider named `OpenAI`, which enables native remote compaction; it calls
`thread/compact/start` after one successful seed turn. Native network
requests outside loopback are blocked by a non-listening proxy.

## Native source and upstream boundary

In the `rust-v0.169.0` source:

- `codex-rs/codex-api/src/api_bridge.rs`: HTTP 429 with
  `error.type: usage_limit_reached` becomes `UsageLimitReached`, with a
  parsed body reset and response-header snapshot.
- `codex-rs/codex-api/src/sse/responses_error.rs`: the streamed error parser
  decodes `type`, `plan_type` and `resets_at` but does not use them to preserve
  this usage-limit error. The fallback carries only its message.
- `codex-rs/core/src/session/turn.rs`: normal-turn `UsageLimitReached`
  forwards its rate-limit snapshot.
- `codex-rs/core/src/compact_remote_v2.rs`: the failure path emits the
  prefixed error without that snapshot update.

Upstream should preserve the usage-limit discriminator and absolute reset
for streamed failures, and forward the failure response's rate-limit
update during remote compaction. The HTTP-400 control demonstrates what
OAR can read when the JSON survives; it is not a claim that the production
service normally uses HTTP 400 for plan exhaustion.
