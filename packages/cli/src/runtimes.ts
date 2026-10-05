import { createCursorRuntime, createRuntimeRegistry, defaultRuntimes as builtInRuntimes } from "@botiverse/oar";
import { createMorphRuntime } from "@botiverse/oar/community";

/** OAR's built-in runtimes, plus cursor on the `@cursor/sdk` this CLI depends on, plus the community runtimes. */
export const runtimes = createRuntimeRegistry([
  ...builtInRuntimes.list(),
  createCursorRuntime({
    sdk: async () => {
      const sdk = await import("@cursor/sdk");
      return sdk;
    },
  }),
  createMorphRuntime(),
]);
