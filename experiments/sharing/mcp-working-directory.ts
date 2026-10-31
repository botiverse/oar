/** Reproducible native stdio controls, including user configuration hidden from session options. */
/* oxlint-disable no-await-in-loop -- Keep each fixture and its cold native data directory independent. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeMcpWorkingDirectory } from "./mcp-working-directory-probe.js";

const [runtime] = process.argv.slice(2); assert.ok(runtime === "grok" || runtime === "opencode");
const output = path.resolve(process.argv[3] ?? "oar-trial-run/mcp-working-directory"); await mkdir(output, { recursive: true });
for (const source of ["session", "user"] as const) {
  for (const placement of ["shared", "isolated"] as const) {
    const row = await observeMcpWorkingDirectory(runtime, placement, source);
    await writeFile(path.join(output, `${source}-${placement}.json`), JSON.stringify(row, null, 2));
    console.log(JSON.stringify(row));
    if (!Array.isArray(row.errors) || row.errors.length > 0) { process.exitCode = 1; }
  }
}
