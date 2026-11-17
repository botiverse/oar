import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dshEnvironment } from "../../packages/oar/src/runtimes/dsh/launch.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { say, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/dsh-user-config.json");
await withDshFixture(() => say("unused"), async ({ installation, aimock, open }) => {
  assert.ok(installation.via === "executable");
  const options = { cwd: aimock.cwd, env: dshEnvironment(aimock.env), timeoutMs: 30_000 };
  const included = await runExecutable(installation.command, ["--profile", "acp", "--dump-config"], options);
  const defaults = await runExecutable(installation.command, ["--profile", "acp", "--dump-default-config"], options);
  const withPatch = await runExecutable(installation.command, ["--profile", "acp", "--dump-default-config", "--patch", path.join(aimock.home, "cordis.patch.yml")], options);
  const publicFailure = await open({ userConfiguration: "exclude" }).catch(String);
  const selected = { version: installation.version, included: { ok: included.ok, hasRoute: included.stdout.includes("OAR_DSH_AIMOCK_KEY"), stdout: included.stdout }, defaults: { ok: defaults.ok, hasRoute: defaults.stdout.includes("OAR_DSH_AIMOCK_KEY"), stdout: defaults.stdout }, withPatch, publicFailure };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(selected, null, 2));
  assert.equal(included.ok, true);
  assert.equal(defaults.ok, true);
  assert.equal(selected.included.hasRoute, true);
  assert.equal(selected.defaults.hasRoute, false);
  assert.equal(withPatch.ok, false);
  assert.ok(typeof publicFailure === "string");
  assert.match(publicFailure, /provider/u);
});
console.log(JSON.stringify({ output, passed: true }));
