import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { piEnvBashTool } from "../../packages/oar/src/runtimes/pi/session.js";

import captureChildProcesses from "../fixtures/child-process-diagnostics.js";

// oxlint-disable-next-line init-declarations -- Installed before each test and restored in afterEach, including failures.
let capture: ReturnType<typeof captureChildProcesses>;
beforeEach(({ task }) => { capture = captureChildProcesses(task.name.includes("removals") ? "pi-env-removal" : "pi-env-overlay"); });
afterEach(async () => { capture.stop(); vi.unstubAllEnvs(); await capture.save(); });

// No model in the loop: the tool definition is executed directly, which is
// exactly what pi's agent loop does with it once the registry override lands
// (that override is pinned by reading the SDK's _refreshToolRegistry).
test("pi env overlay reaches the processes the agent spawns", async () => {
  capture.stage("sdk-and-tool-start");
  const tool = await piEnvBashTool(process.cwd(), { OAR_PI_ENV_PROBE: "overlay-landed" });
  assert.equal(tool.name, "bash");
  capture.stage("tool-execute");
  const result = await tool.execute(
    "probe-1",
    { command: `"${process.execPath}" -p "process.env.OAR_PI_ENV_PROBE"` },
    undefined,
    undefined,
    // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- bash execute only reads ctx behind a guard (session env exposure); there is no session in this unit test
    undefined as unknown as ExtensionToolContext,
  );
  capture.stage("tool-returned");
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  assert.ok(text.includes("overlay-landed"), `env did not reach the spawned process: ${text}`);
});

test("pi env removals affect the real bash child while the host and other keys stay intact", async () => {
  vi.stubEnv("OAR_PI_ENV_REMOVE", "host-value");
  vi.stubEnv("OAR_PI_ENV_KEEP", "keep-value");
  capture.stage("sdk-and-tool-start");
  const tool = await piEnvBashTool(process.cwd(), { OAR_PI_ENV_REMOVE: null, OAR_PI_ENV_PROBE: "new-value" });
  capture.stage("tool-execute");
  const result = await tool.execute("probe-2", {
    command: `"${process.execPath}" -p "JSON.stringify([Object.hasOwn(process.env, 'OAR_PI_ENV_REMOVE'), process.env.OAR_PI_ENV_PROBE, process.env.OAR_PI_ENV_KEEP])"`,
  }, undefined, undefined,
  // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- No session needed by the native bash execution path.
  undefined as unknown as ExtensionToolContext);
  capture.stage("tool-returned");
  expect(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).toContain('[false,"new-value","keep-value"]');
  expect(process.env.OAR_PI_ENV_REMOVE).toBe("host-value");
});
