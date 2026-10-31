/** Manual negative control for configured plugin children. A mismatch fails the evidence step. */
/* oxlint-disable no-await-in-loop -- Each disposable process/configuration cohort completes before the next starts. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeOpenCodeHookWorkingDirectory } from "./opencode-hook-working-directory-probe.js";
import { comparePluginEnvironment } from "./plugin-environment-comparison.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/opencode-sharing/plugin-environment");
await mkdir(output, { recursive: true });
for (const scope of ["user", "project"] as const) {
  const shared = await observeOpenCodeHookWorkingDirectory(scope, "shared");
  const isolated = await observeOpenCodeHookWorkingDirectory(scope, "isolated");
  const comparison = comparePluginEnvironment(shared, isolated);
  for (const [name, value] of Object.entries({ shared, isolated, comparison })) {
    await writeFile(path.join(output, `${scope}-${name}.json`), JSON.stringify(value, null, 2));
  }
  console.log(JSON.stringify({ scope, comparison }));
  if (!comparison.passed) { process.exitCode = 1; }
}
