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

Grok and Kimi share an internal ACP v1 transport and session kernel, but only their concrete runtime identities are public. The registry deliberately does not expose a generic `acp` runtime.

The command-line interface is a separate package: `@botiverse/oar-cli`.
