import { createCursorRuntime, createRuntimeRegistry, defaultRuntimes as builtInRuntimes } from "@botiverse/oar";
import { createMorphRuntime } from "@botiverse/oar/community";

/**
 * Cursor on the `@cursor/sdk` this CLI depends on: in this process by
 * default, or with `OAR_CURSOR_EXECUTION=subprocess` in a Node child per
 * session and call, which imports the SDK from where this CLI resolves it
 * (docs/runtimes/cursor.md#execution-modes). The in-process loader stays
 * written out, so this compile still checks the SDK against `CursorSdk`.
 */
function cursorRuntime(): ReturnType<typeof createCursorRuntime> {
  if (process.env.OAR_CURSOR_EXECUTION === "subprocess") {
    return createCursorRuntime({ execution: "subprocess", sdkModule: import.meta.resolve("@cursor/sdk") });
  }
  return createCursorRuntime({
    sdk: async () => {
      const sdk = await import("@cursor/sdk");
      return sdk;
    },
  });
}

/** OAR's built-in runtimes, plus cursor (above), plus the community runtimes. */
export const runtimes = createRuntimeRegistry([
  ...builtInRuntimes.list(),
  cursorRuntime(),
  createMorphRuntime(),
]);
