import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { startPiAimock } from "../harness/aimock.js";

// oxlint-disable-next-line max-statements -- Prove native stderr is retained and the real session credential redactor is used.
test.skipIf(process.env.OAR_TEST !== "pi-rpc-aimock" || process.env.OAR_PI_RPC_DIAGNOSTICS === undefined)("diagnostics retain native Pi stderr without its session credential", async () => {
  const fixture = await startPiAimock();
  const directory = process.env.OAR_PI_AGENT_DIR;
  const diagnostics = process.env.OAR_PI_RPC_DIAGNOSTICS;
  assert.ok(directory !== undefined && diagnostics !== undefined);
  try {
    const extensions = path.join(directory, "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, "diagnostic.ts"), String.raw`export default pi => { pi.on("session_start", () => { process.stderr.write("diagnostic-stderr: " + process.env.OAR_DIAGNOSTIC_SECRET + "\n"); }); };`);
    const runtime = createPiRuntime({ execution: "subprocess" });
    const installation = await runtime.installation();
    assert.ok(installation.kind === "available");
    const session = await runtime.session(installation, { cwd: directory, env: { ...fixture.env, OAR_DIAGNOSTIC_SECRET: "synthetic-diagnostic-secret" } });
    await session.dispose();
    const names = await readdir(diagnostics);
    const files = names.filter((name) => name.startsWith("stderr-"));
    const contents = await Promise.all(files.map(async (name) => readFile(path.join(diagnostics, name), "utf8")));
    expect(contents.some((text) => text.includes("diagnostic-stderr: [redacted]"))).toBe(true);
    expect(contents.join("\n")).not.toContain("synthetic-diagnostic-secret");
  } finally { await fixture.stop(); }
}, 60_000);
