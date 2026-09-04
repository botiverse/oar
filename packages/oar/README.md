# @botiverse/oar

Provider-independent TypeScript contracts and built-in implementations for controlling and observing Claude, Codex, Grok, Kimi, and Pi.

```ts
import { runtimes } from "@botiverse/oar";

const runtime = runtimes.require("grok");
const installation = await runtime.installation?.();

if (installation?.kind === "available") {
  const session = await runtime.session(installation, { cwd: process.cwd() });
  const result = session.prompt("Inspect this repository");
  if (result.kind === "turn") {
    console.log(await result.turn.outcome);
  }
  console.log(await runtime.accountUsage?.(installation));
  await session.dispose();
}
```

## Public exports

The package has exactly two public entry points:

- `@botiverse/oar` — the full surface: runtime registry, adapters, and everything below. Node-only (adapters import `node:child_process` and runtime SDKs).
- `@botiverse/oar/observe` — browser-safe subset: the pure derivation utilities over `SessionEvent`s (`observeAgent`, `reduceStatus`, `aggregateDeltas`, `observeStalls`, `classifyTool`, …) with zero Node and zero adapter imports. A browser or Electron-renderer bundle can import this subpath directly without dragging Node-only modules in. The root export re-exports the same utilities for Node consumers.

Any other deep import (`@botiverse/oar/dist/...`, source paths) is internal and may break without notice.

Grok and Kimi share an internal ACP v1 transport and session kernel, but only their concrete runtime identities are public. The registry deliberately does not expose a generic `acp` runtime.

The command-line interface is a separate package: `@botiverse/oar-cli`.
