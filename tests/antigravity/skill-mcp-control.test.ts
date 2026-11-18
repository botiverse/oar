/* oxlint-disable max-statements -- The ordered phase-race fixture keeps setup, invocation and retained-artifact checks together. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
// oxlint-disable-next-line import/no-namespace -- Intercept the native boundary while retaining the real direct-marker runner.
import * as executable from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { antigravitySkillMcpControl } from "../../sea-trial/vendor/support/antigravity-skill-mcp.js";

async function markerPath(config: string): Promise<string> {
  const value = asRecord(parseJson(await readFile(config, "utf8")));
  const args = asRecord(asRecord(value?.mcpServers)?.marker)?.args; assert.ok(Array.isArray(args));
  const entries: unknown[] = args;
  const [, path] = entries; assert.ok(typeof path === "string"); return path;
}

test.skipIf(process.platform === "win32").each(["native", "file"] as const)("MCP detector attributes a late %s marker to its own phase", async writer => {
  const home = await mkdtemp(join(tmpdir(), "oar-mcp-marker-"));
  const run = executable.runExecutable;
  const { skills } = antigravityRuntime;
  const observations: unknown[] = [];
  let scope = 0; let config = ""; let nativeMarker = "";
  const env = { HOME: home, USERPROFILE: home };
  vi.spyOn(executable, "runExecutable").mockImplementation(async (command, args, options) => {
    if (command === process.execPath) { return run(command, args, options); }
    config = join(home, scope++ === 0 ? ".agents/mcp_config.json" : ".gemini/config/mcp_config.json");
    nativeMarker = await markerPath(config);
    return { ok: true, stdout: "", stderr: "", exitCode: null };
  });
  vi.spyOn(antigravityRuntime, "skills").mockImplementation(async (installation, options) => {
    const fileMarker = await markerPath(config);
    assert.notEqual(fileMarker, nativeMarker);
    // Deterministic late-child delivery after native exit, during the file phase.
    await writeFile(writer === "native" ? nativeMarker : fileMarker, "started");
    return skills(installation, options);
  });
  try {
    const operation = antigravitySkillMcpControl({ kind: "available", via: "executable", command: "synthetic-agy", version: "1.5.11" }, home, home, env, { ...env, GEMINI_HOME: null }, observations);
    await (writer === "file" ? assert.rejects(operation, { code: "ERR_ASSERTION", actual: true, expected: false }) : operation);
    const starts = observations.filter(item => asRecord(item)?.case === "mcp-start");
    assert.deepEqual(starts, (writer === "file" ? ["workspace"] : ["workspace", "global"]).map(value => ({
      case: "mcp-start", scope: value, nativeStarted: false, nativeStartedAfterFile: writer === "native", fileStarted: writer === "file",
    })));
  } finally { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); }
});
