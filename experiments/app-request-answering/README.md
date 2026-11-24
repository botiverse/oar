# Host-answered approvals: contract shipped, vendor adoption blocked

**Status:** the provider-independent round-trip is implemented and tested
(`Session.answer`, `capabilities.appRequests`,
`@botiverse/oar/kernel`'s `createAppRequestAnswers`; contract
[`docs/spec/app-requests.md`](../../docs/spec/app-requests.md)). **No vendor
adapter hands an approval to a host yet.** This page records what each
runtime's native evidence already proves, what is still missing, and why the
adapters were not changed here.

## What shipped

- `contracts/answer.ts`: `AppRequestDecision`, `AnswerOptions`,
  `AnswerOutcome` (`accepted` / `unconfirmed` / `timeout` / `aborted` /
  `rejected`), `AnswerRejectionCode`, `AppRequestAnswering`.
- `shared/app-request-answers.ts`: correlation by the `toApp` request record
  id, one answer per request, the unanswered policy, native
  `app_request_cancelled` / dispose / exit / release settlement, and the
  `answered` response with `by: "host"` (through the kernel, so the session's
  credential redactor applies).
- `Session.answer` (optional; presence is the capability) and
  `SessionCapabilities.appRequests` /
  `SessionCapabilityDeclaration.answer`.
- `AnswerOptions.signal` bounds only the wait after dispatch: an abort ends
  the acknowledgment wait at once and reports `unconfirmed` — the reply stays
  written and recorded, OAR claims neither native application nor that native
  execution stopped, and a late receipt changes no outcome or duplicate
  answer (regressed in `tests/app-request-answer.test.ts`).
- Tests: `tests/app-request-answer.test.ts` (every outcome and edge) and the
  shared behavior case `session.answer-approval-round-trip`, which runs on
  the in-process mock. The mock (`sea-trial/fixtures/mock-session.ts`) is the
  reference adapter: an approval prompt registers a request, the host answer
  is a record, an unanswered request is bounded by a deny policy, and
  teardown withdraws it.

No vendor adopter means no aimock/vendor test can exercise the round-trip:
aimock scripts the model provider, not the runtime's permission protocol.
Adding one now would assert a reply no vendor has been observed to apply.

## Native evidence, per runtime

### Claude — protocol proven, interaction policy not adopted

[claude-permissions](../claude-permissions/README.md) drove Claude 2.1.311
against a local scripted provider. With `--permission-mode default` (or
`acceptEdits`) plus `--permission-prompt-tool stdio`, Bash produced a native
`control_request {subtype: "can_use_tool"}`; a native `control_response`
carrying `{subtype:"success", request_id, response:{behavior:"allow",
updatedInput}}` created the file, and `behavior:"deny"` did not. Without an
answer the turn did not finish within 4 s (not proof of an infinite hang).
`--permission-mode default --permission-prompts none` denied locally and sent
no request.

What OAR does today: records the request verbatim, never replies
([regression](../../tests/claude/claude-permission-request.test.ts)); launch
policy refuses interactive prompt targets
([decision](../../docs/design/decisions.md#noninteractive-native-permission-modes-not-host-approvals-2026-10-28)).

Missing before adoption:

1. an explicit launch option that selects an interactive prompt target
   together with a mode, instead of relaxing `launchArgs` incidentally;
2. the reply writer and its association with the recorded request id;
3. a native fixture that shows the reply is applied under that launch
   configuration on the pinned version, including a denial and an
   `updatedInput` round-trip;
4. a decision on `updatedInput`: the generic decision does not rewrite tool
   input, so the adapter must deny `scope: "always"` when the protocol has no
   lasting option and must not silently drop an input rewrite.

### ACP (kimi, grok, antigravity, opencode, codebuddy, qwen, factory, droid…) — protocol typed, routing policy not adopted

The SDK (`@agentclientprotocol/sdk` 1.4.0) types both sides:
`session/request_permission` carries `options` with `optionId` and
`kind` (`allow_once` / `allow_always` / reject kinds), and the response is
`{outcome:{outcome:"selected", optionId}}` or `{outcome:{outcome:"cancelled"}}`.
OAR's client app already selects `allow_always` (else `allow_once`) and
records the pair ([`allowPermission`](../../packages/oar/src/shared/acp/client-app.ts)).
The recorded contract and the `answer` decision map cleanly.

Missing before adoption:

1. an opt-out of the fixed allow policy per session/placement;
2. a hold in the SDK handler while a host decides, with a bounded wait that
   cannot outlive the native session (shared routing can reassign or expire a
   request — [`routing.ts`](../../packages/oar/src/shared/acp/routing.ts));
3. a native fixture for each ACP vendor's permission options: which
   optionIds really exist, whether `selected` is acknowledged, and what the
   runtime does when the request is cancelled;
4. a rule for a shared connection: one request can belong to another root's
   session, so ownership must follow the routed target, not the client app.

### Codex — only the refusal is proven

OAR answers every app-server server request at once with the native refusal
(`decline`, `denied`, an empty grant, `success:false`), because `Session` had
no answer API ([runtime page](../../docs/runtimes/codex.md#tools-permissions-and-client-callbacks),
[native refusal](../../sea-trial/vendor/codex-runtime-requests.vendor.test.ts)).
The accept spelling for `item/commandExecution/requestApproval` has not been
observed on the pinned app-server; the runtime page's approval policy is
`never`, so requests are rare.

Missing: a native capture of an accepted decision (`accept`/`acceptForSession`
and the `item/permissions/requestApproval` grant shape), an explicit opt-in
to a non-`never` approval policy, and a vendor regression showing the tool
runs only after the host's `allow`. Until then an `allow` mapping would be a
guess.

### Other runtimes

pi (extension UI requests), factory/droid (`droid.request_permission`) and
morph record `toApp` requests too. Each needs the same two proofs — the
native reply that means allow/deny and a vendor fixture where that reply is
applied — before it can expose `Session.answer`. None was attempted here.

## Why the adapters were left automatic

The design decision that deferred this work said the reopen condition was a
host that needs to present a native request to a human, and that a generic
answer API needs ownership, response records, cancellation/exit handling and
an unanswered policy. Shipping the shared contract answers those four without
claiming any vendor can be driven interactively. Relaxing a launch flag or
switching an ACP handler to "wait for a host" without the vendor fixtures
above would turn a missing answer into a hung turn under a new name.

## Reproduce and validate

```sh
pnpm exec vitest run tests/app-request-answer.test.ts
pnpm sea-trial                 # the mock runs session.answer-approval-round-trip
OAR_TEST=scripted pnpm sea-trial
```

The behavior case skips on every backend whose session has no `answer`, and
passes on the mock; that skip is the current, honest vendor state. Once an
adapter opts in, the same case exercises it on that aimock backend without a
new test shape.
