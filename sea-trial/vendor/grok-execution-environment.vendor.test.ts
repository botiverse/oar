/** Manual native controls: a counterexample does not authorize production sharing. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { observeMcpWorkingDirectory } from "../../experiments/sharing/mcp-working-directory-probe.js";
import { observeGrokHookWorkingDirectory } from "../../experiments/sharing/grok-hook-working-directory-probe.js";

const enabled = process.env.OAR_TEST === "grok-shared";
async function retain(name: string, row: unknown): Promise<void> {
  const out = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "grok-sharing", "execution-environment");
  await mkdir(out, { recursive: true }); await writeFile(path.join(out, `${name}.json`), JSON.stringify(row, null, 2));
}
for (const placement of ["shared", "isolated"] as const) {
  for (const source of ["session", "user"] as const) {
    test.skipIf(!enabled)(`Grok native stdio MCP ${source}/${placement} keeps its observed cwd behavior`, async () => {
      const row = await observeMcpWorkingDirectory("grok", placement, source); await retain(`mcp-${source}-${placement}`, row);
      expect(row.errors).toEqual([]);
      expect(row.sessionDirectoriesObserved).toEqual([placement === "isolated", placement === "isolated"]);
      expect(row.observations).toEqual(expect.arrayContaining([expect.objectContaining({ environmentMarker: "oar-execution-fixture" })]));
    }, 120_000);
  }
  for (const scope of ["user", "project"] as const) {
    test.skipIf(!enabled)(`Grok ${scope}/${placement} hooks execute in their owning session directory`, async () => {
      const row = await observeGrokHookWorkingDirectory(scope, placement); await retain(`hooks-${scope}-${placement}`, row);
      expect(row.errors).toEqual([]);
    }, 120_000);
  }
}
