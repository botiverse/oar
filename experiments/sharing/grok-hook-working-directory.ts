/** Compare actual hook process cwd, not only the cwd named in its native event. */
/* oxlint-disable no-await-in-loop -- Keep each disposable configuration independent. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeGrokHookWorkingDirectory } from "./grok-hook-working-directory-probe.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/grok-hook-cwd"); await mkdir(output, { recursive: true });
for (const scope of ["user", "project"] as const) {
  for (const placement of ["shared", "isolated"] as const) {
    const row = await observeGrokHookWorkingDirectory(scope, placement);
    await writeFile(path.join(output, `${scope}-${placement}.json`), JSON.stringify(row, null, 2));
    console.log(JSON.stringify(row));
    if (!Array.isArray(row.errors) || row.errors.length > 0) { process.exitCode = 1; }
  }
}
