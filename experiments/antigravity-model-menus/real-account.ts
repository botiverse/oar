/** Deliberate signed-in entry point. No raw native output is retained. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { probeRealMenus } from "./probe.js";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, output, directory] = process.argv.slice(2);
  assert.ok(process.env.OAR_TEST === "antigravity", "Set OAR_TEST=antigravity for this deliberate signed-in probe");
  assert.ok(command !== undefined && output !== undefined, "Usage: real-account.ts /absolute/agy output.json [workspace]");
  const report = await probeRealMenus(path.resolve(command), path.resolve(directory ?? process.cwd()), process.env);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (report.failure !== null || asRecord(report.restoration)?.confirmed === false) { process.exitCode = 1; }
}
