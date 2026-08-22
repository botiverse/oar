import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piEnvBashTool } from "../packages/oar/src/runtimes/pi/session.js";

// No model in the loop: the tool definition is executed directly, which is
// exactly what pi's agent loop does with it once the registry override lands
// (that override is pinned by reading the SDK's _refreshToolRegistry).
test("pi env overlay reaches the processes the agent spawns", async () => {
  const tool = await piEnvBashTool(process.cwd(), { OAR_PI_ENV_PROBE: "overlay-landed" });
  assert.equal(tool.name, "bash");
  const result = await tool.execute(
    "probe-1",
    { command: `"${process.execPath}" -p "process.env.OAR_PI_ENV_PROBE"` },
    undefined,
    undefined,
    // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- bash execute only reads ctx behind a guard (session env exposure); there is no session in this unit test
    undefined as unknown as ExtensionContext,
  );
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  assert.ok(text.includes("overlay-landed"), `env did not reach the spawned process: ${text}`);
});
