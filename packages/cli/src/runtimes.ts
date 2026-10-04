import { createCursorRuntime, createRuntimeRegistry, runtimes as builtInRuntimes } from "@botiverse/oar";

/** OAR's built-in runtimes, plus cursor on the `@cursor/sdk` this CLI depends on. */
export const runtimes = createRuntimeRegistry([
  ...builtInRuntimes.list(),
  createCursorRuntime({
    sdk: async () => {
      const sdk = await import("@cursor/sdk");
      return sdk;
    },
  }),
]);
