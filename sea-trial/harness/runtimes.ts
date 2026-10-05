import { createCursorRuntime, createRuntimeRegistry, defaultRuntimes } from "../../packages/oar/src/index.js";

/**
 * Every runtime this repo probes: OAR's built-ins, plus cursor on the
 * `@cursor/sdk` the workspace installs, added the way a host adds it. Its
 * `import("@cursor/sdk")` is also where this repo's typecheck checks the SDK
 * against `CursorSdk`.
 */
export const allRuntimes = createRuntimeRegistry([
  ...defaultRuntimes.list(),
  createCursorRuntime({
    sdk: async () => {
      const sdk = await import("@cursor/sdk");
      return sdk;
    },
  }),
]);
