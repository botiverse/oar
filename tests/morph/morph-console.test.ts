import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { acquireConsole, discoverConsole, morphStateDir } from "../../packages/oar/src/runtimes/morph/console.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-morph-console.mjs", import.meta.url));

/** A `morph` executable that runs the fake Console, and an empty state directory. */
function scratch(): { command: string; stateDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "oar-morph-console-"));
  const command = path.join(root, "morph");
  writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(command, 0o755);
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir);
  return { command, stateDir };
}

const starts = (stateDir: string): string[] => (existsSync(path.join(stateDir, "starts.log")) ? readFileSync(path.join(stateDir, "starts.log"), "utf8").trim().split("\n") : []);

test("the state directory follows morph: env, then the config's file_state_dir, then ~/.morph", () => {
  const home = mkdtempSync(path.join(tmpdir(), "oar-morph-home-"));
  assert.equal(morphStateDir({}, home), path.join(home, ".morph"));
  assert.equal(morphStateDir({ MISTER_MORPH_FILE_STATE_DIR: "~/state" }, home), path.join(home, "state"));
  mkdirSync(path.join(home, ".morph"));
  writeFileSync(path.join(home, ".morph", "config.yaml"), "llm:\n  file_state_dir: nested\nfile_state_dir: \"~/elsewhere\" # moved\n");
  assert.equal(morphStateDir({}, home), path.join(home, "elsewhere"));
  const config = path.join(home, "other.yaml");
  writeFileSync(config, "file_state_dir: /srv/morph\n");
  assert.equal(morphStateDir({ MISTER_MORPH_CONFIG: config }, home), "/srv/morph");
});

test("a stale runtime.json from a dead Console is not a Console", async () => {
  const { stateDir } = scratch();
  mkdirSync(path.join(stateDir, "console"));
  writeFileSync(path.join(stateDir, "console", "runtime.json"), JSON.stringify({ url: "http://127.0.0.1:9/runtime", token: "x" }));
  assert.equal(await discoverConsole(stateDir), null);
});

test.skipIf(process.platform === "win32")("without a running Console one is started, shared, and stopped with the last lease", async () => {
  const { command, stateDir } = scratch();
  const first = await acquireConsole(command, stateDir);
  const second = await acquireConsole(command, stateDir);
  assert.equal(first.owned, true);
  assert.equal(second.client.endpoint.url, first.client.endpoint.url);
  assert.deepEqual(starts(stateDir), ["console serve --console-listen 127.0.0.1:0"]);
  assert.equal(await first.release(), null);
  assert.notEqual(await discoverConsole(stateDir), null);
  assert.deepEqual(await second.release(), { code: 0 });
  assert.equal(await discoverConsole(stateDir), null);
});

test.skipIf(process.platform === "win32")("a Console already running is attached to and never stopped", async () => {
  const { command, stateDir } = scratch();
  const owner = await acquireConsole(command, stateDir);
  // A second process would see only the published file: emulate it by
  // attaching through discovery while the first lease keeps it alive.
  const running = await discoverConsole(stateDir);
  assert.ok(running !== null);
  assert.equal(running.endpoint.token, "fake-token");
  await owner.release();
});
