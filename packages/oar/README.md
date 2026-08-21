# @botiverse/oar

Provider-independent TypeScript contracts and built-in implementations for observing agent runtimes.

```ts
import { runtimes } from "@botiverse/oar";

const codex = runtimes.require("codex");
const installation = await codex.installation?.probe();
const usage = await codex.accountUsage?.read();
```

The command-line interface is a separate package: `@botiverse/oar-cli`.
