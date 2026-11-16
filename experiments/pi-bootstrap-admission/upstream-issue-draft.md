# Draft: RPC loses a prompt response when bootstrap settlement starts compaction

Not submitted. The OAR maintainer will publish and track this upstream.

## Versions and scope

Observed with `@earendil-works/pi-coding-agent` 1.5.0 on Linux x64,
Node 24.19.0. The published 1.5.2 source still has the same relevant ordering;
1.5.2 has not been executed for this reproduction. A loopback scripted model
provides the bootstrap and compaction responses. No account is needed.

## Minimal sequence

An extension starts BOOT in `session_start` and holds its first
`agent_settled` hook. The model request has finished while the hook is held.
After an RPC prompt D arrives, release the hook, start compaction, and let
the hook return before compaction finishes:

```ts
let first = true;
let settling = false;
pi.on("agent_settled", async (_event, ctx) => {
  if (!first) return;
  first = false;
  settling = true;
  await waitForHostRelease();
  ctx.compact({ onComplete: markCompacted, onError: markCompactionError });
  await delay(30); // Compaction is still running when this hook returns.
});
pi.on("session_start", async () => {
  pi.sendUserMessage("BOOT " + "history ".repeat(200));
  while (!settling) await delay(10);
});
```

Keep enough history for a real compaction (`keepRecentTokens: 1` in the
reproduction), and delay the model response or `session_before_compact` hook
so the compaction is active when deferred input runs. `waitForHostRelease`
is a file gate; the executable fixture below supplies it and the model.

While the settlement hook is held, send a uniquely identified native RPC
command such as `{"id":"D","type":"prompt","message":"D"}`. Release the
gate and wait for compaction to finish. D never reaches the input hook and
has no correlated response. An extension error instead belongs to the
extension's `sendUserMessage` invocation and carries no D request ID.

## Actual and expected

RPC subscribes after extension binding, so its startup `agent_start` is
missing. `get_state.isStreaming` is false while the awaited settled hook is
active; no state field exposes this pending settlement work. A host cannot
use that response to distinguish the hook from ordinary idle time.

`prompt()` defers D during settlement and returns immediately. Later,
compaction rejects the deferred action before `preflightResult` runs. RPC
needs that callback to send D's prompt response, and the earlier returned
promise cannot convey the later rejection. The extension-owned BOOT promise
receives the error instead. Its uncorrelated extension error is not enough
for a host to safely decide which input was refused.

Please preserve a correlated terminal admission/refusal response for every
RPC prompt, including deferred prompts rejected before preflight. Exposing
startup run activity and awaited settlement in RPC would also let hosts
avoid submitting into this window. An unrelated extension error should not
be the only way to discover D's refusal.

OAR currently rejects D at its existing 30-second transport deadline and
then cleans up the child. That timeout and exit are host behavior, not a
native refusal receipt. The SDK adapter can subscribe before binding and
now does so; the RPC ordering is inside Pi.

## Executable reproduction and evidence

From [OAR's reproduction](https://github.com/botiverse/oar/tree/98beb26ff76a4107c5b5f70b7e37834da5107410/experiments/pi-bootstrap-admission):

```sh
pnpm install --frozen-lockfile
OAR_TEST=pi-rpc-aimock pnpm tsx experiments/pi-bootstrap-admission/probe.ts
```

The probe uses the native RPC child, an isolated extension directory and
loopback provider. It records D's deadline, actual child exit, extension
hooks and model requests. The extension is in
`sea-trial/vendor/support/pi-bootstrap.ts`; the full protocol/sequence
explanation and selected original records are in that report. In the final
capture D rejects at 30,003 ms; after the actual exit, NEXT rejects
`runtime_exited`. The SDK control now refuses D as busy before submission.

Relevant native files: `dist/modes/rpc/rpc-mode.js` (bind before subscribe,
prompt callback response) and `dist/core/agent-session.js`
(`_emitAgentSettled`, deferred `prompt`, compaction check before preflight).
The 1.5.2 source inspection is explicitly separate from the 1.5.0 execution.
