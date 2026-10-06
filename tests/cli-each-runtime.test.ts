import { expect, test } from "vitest";
import { readEach } from "../packages/cli/src/each-runtime.js";
import { subagentTools } from "../packages/cli/src/mcp-tools.js";
import { createSubagents } from "../packages/oar/src/agents/index.js";

// The CLI resolves `@botiverse/oar` to the built package, whose branded types
// are not identical to the src ones, so fixtures take their shapes from the
// CLI functions under test rather than from the library source.
type Runtime = Parameters<typeof readEach>[0][number];

const noInventory = async () => ({ kind: "unsupported" as const, code: "native_query_unavailable" as const, reason: "not exercised" });

function runtime(id: string, probe: Runtime["installation"]): Runtime {
  return {
    id,
    brand: { name: id, icon: null },
    session: async () => {
      await Promise.resolve();
      throw new Error("not exercised");
    },
    skills: noInventory,
    mcpServers: noInventory,
    tools: noInventory,
    ...(probe === undefined ? {} : { installation: probe }),
  };
}

const present = runtime("present", async () => {
  await Promise.resolve();
  return { kind: "available", via: "executable", command: "/bin/present", version: "1.0.0" };
});
// The probe rejects as a stuck `--version` does (shared/installation.ts).
const stuck = runtime("stuck", async () => {
  await Promise.resolve();
  throw new Error("Failed to run /bin/stuck --version: exit code unavailable; signal SIGTERM; timeout after 15000 ms");
});

test("one runtime that rejects reports its error while the others still report", async () => {
  const reports = await readEach([present, stuck], async (each) => ({ runtimeId: each.id, installation: await each.installation?.() }));
  expect(reports).toEqual([
    { runtimeId: "present", installation: { kind: "available", via: "executable", command: "/bin/present", version: "1.0.0" } },
    { runtimeId: "stuck", error: "Failed to run /bin/stuck --version: exit code unavailable; signal SIGTERM; timeout after 15000 ms" },
  ]);
});

test("the MCP runtimes tool lists every runtime when one probe rejects", async () => {
  const crew = createSubagents({ runtimes: { get: () => undefined } });
  const tool = subagentTools(crew, [present, stuck]).find((each) => each.name === "runtimes");
  await expect(tool?.call({}, new AbortController().signal)).resolves.toEqual([
    { runtime: "present", installation: "available", version: "1.0.0" },
    { runtime: "stuck", installation: "unknown", error: "Failed to run /bin/stuck --version: exit code unavailable; signal SIGTERM; timeout after 15000 ms" },
  ]);
});
