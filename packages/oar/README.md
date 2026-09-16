# @botiverse/oar

Provider-independent TypeScript contracts and built-in implementations for controlling and observing Claude, Codex, Grok, Kimi, and Pi.

```ts
import { promptAndWait, runtimes } from "@botiverse/oar";

const runtime = runtimes.require("grok");
const installation = await runtime.installation?.();

if (installation?.kind === "available") {
  const session = await runtime.session(installation, { cwd: process.cwd() });
  session.events((event) => {
    switch (event.kind) {
      case "text_delta": process.stdout.write(event.text); break;
      case "tool_call_started": console.log(`[${event.tool}]`); break;
      case "turn_ended": console.log(event.outcome.kind); break;
    }
  }, { coalesceText: true });
  const run = await promptAndWait(session, "Inspect this repository");
  console.log(run.kind === "ended" ? run.outcome : run.reason);
  console.log(session.usage(), await runtime.accountUsage?.(installation));
  await session.dispose();
}
```

`session.events()` delivers flat, attributed `Event`s (text, reasoning,
tool call start / progress / end, turn start and end, usage, model,
compaction start / end, retry, runtime→app requests and oar's answers,
control rejections, the process exit), each carrying the `seq` and
`agentPath` of the record it was read from. Kinds a runtime never says
(claude has no compaction start, ACP runtimes no compaction or retry) simply
never appear; the runtime pages say which. It is a projection over the record stream: `session.rawEvents()`
and `session.records()` expose that stream (`RawEvent`: `Frame` with the
native payload verbatim, `RequestRecord`, `ResponseRecord`) for consumers
who need the runtime's own frames.

## Public exports

The package has exactly two public entry points:

- `@botiverse/oar`: the full surface (runtime registry, adapters, and everything below). Node-only (adapters import `node:child_process` and runtime SDKs).
- `@botiverse/oar/observe`: browser-safe subset, the pure derivation utilities over `RawEvent`s and `Event`s (`eventsOf`, `coalesceText`, `observeAgent`, `reduceStatus`, `observeStalls`, `classifyTool`, …) with zero Node and zero adapter imports. A browser or Electron-renderer bundle can import this subpath directly without dragging Node-only modules in. The root export re-exports the same utilities for Node consumers.

Any other deep import (`@botiverse/oar/dist/...`, source paths) is internal and may break without notice.

Grok and Kimi share an internal ACP v1 transport and session kernel, but only their concrete runtime identities are public. The registry deliberately does not expose a generic `acp` runtime.

The command-line interface is a separate package: `@botiverse/oar-cli`.

## Account usage reasons

Unsuccessful account-usage snapshots retain `kind: "unsupported"` or
`kind: "reauth_required"` and now include a stable `reason` from built-in readers.
Consumers should use `reason` rather than infer a cause from the runtime name.
The field is optional for compatibility with older/custom adapters; absent
reasons must be presented as unknown rather than guessed.

| Kind | Reason | Meaning |
| --- | --- | --- |
| unsupported | capability_unavailable | The runtime has no account-usage reader (reported by the CLI/embedding app). |
| unsupported | unsupported_installation | This reader cannot query this installation type. |
| unsupported | unsupported_auth_mode | The selected authentication mode is not supported by the usage reader. This is the adapter's decision, not proof that a token was rejected. |
| unsupported | unsupported_auth_storage | The configured credential storage is not supported. |
| unsupported | auth_configuration_unavailable | The reader could not resolve the provider/auth configuration; no more specific cause is known. |
| unsupported | endpoint_unavailable | The provider/runtime does not expose the queried usage endpoint. |
| unsupported | quota_unavailable | The response does not expose a quota configuration. |
| reauth_required | not_authenticated | The runtime requires a login. |
| reauth_required | credentials_missing | No usable persisted credential was found. |
| reauth_required | scope_missing | The credential lacks the scope needed for usage queries. |
| reauth_required | credentials_rejected | The usage endpoint rejected the credential (401/403). |

Operational failures (network errors, timeouts, malformed responses) still reject
the promise. Reasons do not include tokens, credential values, or raw provider
responses. This change does not alter authentication precedence, refresh tokens,
or probe endpoints that were previously skipped.
