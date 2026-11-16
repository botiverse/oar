import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { dshControl } from "../../packages/oar/src/runtimes/dsh/control.js";
import { dshEnvironment } from "../../packages/oar/src/runtimes/dsh/launch.js";
import { launchProbe } from "./launch.js";
import { runExecutable, type ExecutableResult } from "../../packages/oar/src/shared/executable/index.js";
import { say, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";

const cases = ["profile-separated", "profile-equals", "reset-profile", "disable-bridge", "replace-bridge", "enable-acp", "plugin-directory", "dump-config"] as const;
const output = path.resolve(process.argv[2] ?? "oar-trial-run/dsh-launch-conflicts.json");
const results: unknown[] = [];
for (const name of cases) {
  // oxlint-disable-next-line no-await-in-loop -- Each launch gets its own disposable profile and provider.
  await withDshFixture(() => say("must not run"), async ({ installation, aimock, provider }) => {
    assert.equal(installation.via, "executable");
    const patch = path.join(aimock.cwd, "conflict.json");
    const replacement = path.join(aimock.cwd, "replacement.mjs");
    await writeFile(replacement, String.raw`export function apply() { process.stdout.write("REPLACEMENT_PLUGIN_LOADED\n"); }`);
    const syntax = await runExecutable(process.execPath, ["--check", replacement]);
    assert.equal(syntax.ok, true, syntax.stderr);
    const patches: Record<string, unknown[]> = {
      "disable-bridge": [{ id: "oar-dsh-bridge", disabled: true }],
      "replace-bridge": [{ id: "oar-dsh-bridge", name: pathToFileURL(replacement).href }],
      "enable-acp": [{ id: "acp", disabled: false }],
    };
    await writeFile(patch, JSON.stringify(patches[name] ?? []));
    const argumentsByCase: Record<string, string[]> = {
      "profile-separated": ["--profile", "headless"], "profile-equals": ["--profile=headless"],
      "reset-profile": ["--from-default-profile", "acp"],
      "disable-bridge": ["--patch", patch], "replace-bridge": [`--patch=${patch}`],
      "enable-acp": ["--patch", patch], "plugin-directory": ["--plugin-dir", "fixture-plugins"], "dump-config": ["--dump-config"],
    };
    const args = argumentsByCase[name] ?? [];
    const env = dshEnvironment(aimock.env);
    const { child, directory } = await launchProbe(installation.command, aimock.cwd, { env, args });
    const frames: Record<string, unknown>[] = [];
    const control = dshControl(child, (frame) => { frames.push(frame); });
    let dump: ExecutableResult | null = null;
    try {
      // Readiness alone does not prove absence of a second protocol listener.
      const outcome = await Promise.race([control.ready.then(() => "ready", String), delay(3000).then(() => "observation deadline")]);
      if (name === "disable-bridge" || name === "replace-bridge" || name === "enable-acp") {
        dump = await runExecutable(installation.command, ["--profile", "acp", "--patch", path.join(directory.path, "patch.json"), ...args, "--dump-config"], { cwd: aimock.cwd, env, timeoutMs: 15_000 });
      }
      results.push({ name, args, outcome, frames, dump, stderr: child.diagnostics().stderr, providerRequests: provider.requests.length });
      assert.equal(provider.requests.length, 0);
      if (name.startsWith("profile-")) { assert.match(outcome, /select a profile only once/u); }
      if (name === "reset-profile") { assert.match(outcome, /cannot be a custom profile target/u); }
      if (name === "disable-bridge") {
        assert.equal(outcome, "observation deadline");
        assert.match(dump?.stdout ?? "", /- id: oar-dsh-bridge\n[^#]*disabled: true/u);
      }
      if (name === "replace-bridge") {
        assert.equal(outcome, "ready");
        const expectedBridge = pathToFileURL(path.join(directory.path, "bridge.mjs")).href;
        assert.equal(dump?.stdout.includes(expectedBridge), true);
        assert.equal(JSON.stringify(frames).includes("REPLACEMENT_PLUGIN_LOADED"), false);
      }
      if (name === "enable-acp") { assert.match(dump?.stdout ?? "", /- id: acp\n[^#]*disabled: false/u); }
      if (name === "plugin-directory") { assert.match(child.diagnostics().stderr, /unknown option '--plugin-dir'/u); }
      if (name === "dump-config") { assert.match(outcome, /DSH exited \(0\)/u); }
    } finally { child.kill(); await child.exited; directory.remove(); }
  });
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ output, cases: results.length }));
