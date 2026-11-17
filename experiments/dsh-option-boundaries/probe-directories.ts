import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { say, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { withNativeProbe } from "./native-probe.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/dsh-directories.json");
const source = `async probe(request) {
  const { agent } = owned(request.sessionId);
  const policy = ctx.get("sandboxPolicy").resolve({ session: agent.session });
  const fs = ctx.get("fs");
  try {
    const target = await fs.resolve(request.path, { cwd: agent.session.cwd });
    const written = await fs.writeText(target, "directory control", undefined, undefined, policy);
    return { policy, written, content: await fs.readText(target) };
  } catch (error) { return { policy, error: structured(error) }; }
},`;
const cases: JsonRecord[] = [];
const supportsRoots = process.argv[3] !== "unsupported";
await withDshFixture(() => say("unused"), async (fixture) => {
  assert.ok(fixture.installation.via === "executable");
  await mkdir("oar-trial-run", { recursive: true });
  // Native workspace-write also permits the platform temp directory. Keep the negative control outside it.
  const extra = await mkdtemp(path.resolve("oar-trial-run/dsh-extra-"));
  const run = async (mode: string, roots: string[], partial = false): Promise<void> => {
    const rows = [{ id: "sandbox-policy", config: { mode, additionalWritableRoots: roots } }, ...(partial ? [{ id: "sandbox-policy", config: { additionalWritableRoots: roots } }] : [])];
    const expectedMode = partial ? "read-only" : mode;
    await withNativeProbe(fixture, { source, rows }, async (control) => {
      const sessionId = `11111111-1111-4111-8111-${  String(cases.length).padStart(12, "0")}`;
      await control.request("open", { sessionId, cwd: fixture.aimock.cwd });
      const primary = await control.request("probe", { sessionId, path: path.join(fixture.aimock.cwd, `primary-${String(cases.length)}`) });
      const secondary = await control.request("probe", { sessionId, path: path.join(extra, `extra-${String(cases.length)}`) });
      cases.push({ mode, roots, partial, primary, secondary });
      assert.equal(asRecord(primary.policy)?.workspaceRoot, fixture.aimock.cwd);
      assert.equal(asRecord(primary.policy)?.mode, expectedMode);
      if (expectedMode === "workspace-write") {assert.equal(primary.content, "directory control");}
      else {assert.ok(primary.error !== undefined);}
      if (expectedMode === "workspace-write" && roots.length > 0 && supportsRoots) {assert.equal(secondary.content, "directory control");}
      else {assert.ok(secondary.error !== undefined);}
    });
  };
  try {
    await run("workspace-write", []);
    await run("workspace-write", [extra]);
    await run("read-only", [extra]);
    await run("workspace-write", [extra], true);
    await run("workspace-write", []);
  } finally {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ version: fixture.installation.version, supportsRoots, cases, requests: fixture.provider.requests.length }, null, 2));
    await rm(extra, { recursive: true, force: true });
  }
});
console.log(JSON.stringify({ output, passed: true, cases: cases.length }));
