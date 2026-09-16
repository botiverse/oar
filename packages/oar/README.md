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
responses.

Claude account usage delegates to its native stream-json `get_usage` request
(with `skip_behaviors: true`). OAR does not read Claude credentials or call its
HTTP quota endpoint. A native `rate_limits_available: false` becomes
`quota_unavailable`; it does not prove invalid credentials. Older CLIs that
reject the control request return `endpoint_unavailable`. Query-process session
totals are not returned as account usage.

## Native inventories

Every runtime exposes `skills(installation, options?)`,
`mcpServers(installation, options?)`, and `tools(installation, options?)`.
Options are `{ cwd?: string, timeoutMs?: number }`; cwd defaults to
`process.cwd()`. Queries independently discover native information and do not
inspect an existing Session or submit a model prompt.

Results distinguish `ok`, `unsupported`, and `unavailable`. Successful results
contain `items`, `scope.cwd`, `observedAt`, `view`, and `partial`. A
`mcp-only` view excludes built-in tools. Unknown schema or state fields stay
absent, and an unsupported query never pretends to be an empty catalog.

Codex and Claude expose skills and MCP discovery (tools are MCP-only); Grok
exposes independent skills/MCP configuration discovery; Pi exposes skills and
registered tools with active membership. Kimi inventory is unsupported on the
selected transport. Native startup can load extensions and connect configured
MCP servers.

Custom runtimes should use `defineRuntime`, which fills unavailable inventory
methods with explicit unsupported results. A manually constructed `Runtime`
must implement the three methods.

### Runtime branding

`runtime.brand` contains `{ name, icon }`. Built-in icons are self-contained SVG
data URIs, usable as an `<img src>` offline and serializable across IPC. No
installation, login, or runtime process is needed to read branding.

For browser-only consumers (without loading native SDKs):

```ts
import { runtimeBrands } from "@botiverse/oar/brands";
const { name, icon } = runtimeBrands.claude;
```

SVG files are also exported at `@botiverse/oar/assets/brands/<runtime-id>.svg`.
Their attribution and licenses ship in `assets/brands/NOTICE.md`. Pi uses the official `pi.dev/logo-on-dark.svg` asset, intended for dark backgrounds.
Custom runtimes created with `defineRuntime` may supply `brand`; otherwise it
defaults to `{ name: runtime.id, icon: null }`. Runtime branding identifies the
provider and is independent of an application's project avatars.

`brand.icons?.light` and `brand.icons?.dark` optionally override the default for
light and dark **backgrounds**. They are not required to be distinct or both
present. `runtimeBrandIcon(brand, theme)` returns the matching variant, falling
back to `brand.icon` (including null for brands without artwork). Hosts choose
the theme from their own surface, not necessarily the operating system setting.

```ts
import { runtimeBrands, runtimeBrandIcon } from "@botiverse/oar/brands";
const src = runtimeBrandIcon(runtimeBrands.codex, "dark");
```
