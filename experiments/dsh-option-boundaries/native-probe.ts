// oxlint-disable import/max-dependencies -- This experiment combines the launch fixture with its native protocol probe.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dshBridgeSource } from "../../packages/oar/src/runtimes/dsh/bridge.js";
import { dshControl, type DshControl } from "../../packages/oar/src/runtimes/dsh/control.js";
import { dshEnvironment } from "../../packages/oar/src/runtimes/dsh/launch.js";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";
import { privateTempDir } from "../../packages/oar/src/shared/private-temp.js";
import type { DshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";

/** Extra native calls exist only in this experiment; production never loads them. */
export async function withNativeProbe(fixture: DshFixture, probe: { source: string; rows: readonly JsonRecord[] }, body: (control: DshControl, frames: JsonRecord[]) => Promise<void>): Promise<void> {
  const { installation, aimock } = fixture;
  const { source, rows } = probe;
  assert.ok(installation.via === "executable");
  const directory = await privateTempDir("oar-dsh-native-probe-");
  const anchor = "  const commands = {";
  assert.equal(dshBridgeSource.split(anchor).length, 2);
  const bridge = path.join(directory.path, "bridge.mjs");
  const patch = path.join(directory.path, "patch.json");
  await writeFile(bridge, dshBridgeSource.replace(anchor, `${anchor}\n${source}`));
  await writeFile(patch, JSON.stringify([{ id: "acp", disabled: true }, ...rows, { insert: [{ id: "oar-dsh-bridge", name: pathToFileURL(bridge).href }] }]));
  const child = spawnLineProcess(installation.command, ["--profile", "acp", "--patch", patch], { cwd: aimock.cwd, env: dshEnvironment(aimock.env), killTree: true, shutdown: "stdin" });
  const frames: JsonRecord[] = [];
  const control = dshControl(child, (frame) => { frames.push(frame); });
  try { await control.ready; await body(control, frames); await control.request("dispose"); }
  finally { child.kill(); await child.exited; directory.remove(); }
}
