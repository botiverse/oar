import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { antigravityInstalledExecutableCandidates, readAntigravityVersion } from "../../packages/oar/src/runtimes/antigravity/installation.js";
import { antigravityAcpArgs } from "../../packages/oar/src/runtimes/antigravity/launch.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";
import { printingExecutable } from "../fixtures/update-fixtures.js";

let dir = "";
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "oar-agy-cli-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

test("CLI launch is acp on every platform; legacy overrides keep their prior arguments", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    expect(antigravityAcpArgs("/custom/agy", platform)).toEqual(["acp"]);
  }
  expect(antigravityAcpArgs("/custom/agy_acp_server.par", "linux")).toEqual(["--uid="]);
  expect(antigravityAcpArgs(String.raw`C:\tools\agy_acp_server.exe`, "win32")).toEqual([]);
  expect(antigravityAcpArgs("/custom/agy_acp_server.par", "darwin")).toEqual([]);
  expect(antigravityAcpArgs("/custom/renamed-server", "linux")).toEqual(["--uid="]);
  expect(readAntigravityVersion("1.4.12\n")).toBe("1.4.12");
});

test("official install layout and legacy fallback are platform-specific", () => {
  expect(antigravityInstalledExecutableCandidates("linux", "/home/oar")).toEqual(["/home/oar/.local/bin/agy", "agy_acp_server.par"]);
  expect(antigravityInstalledExecutableCandidates("win32", String.raw`C:\Users\oar`)).toEqual([String.raw`C:\Users\oar\.local\bin\agy.exe`, "agy_acp_server.exe"]);
});

test.skipIf(process.platform === "win32")("discovery finds the CLI off PATH and a missing override never falls back", async () => {
  const home = path.join(dir, "home");
  const bin = path.join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const command = printingExecutable({ dir: bin, name: "agy", line: "1.4.12" });
  const env = { HOME: home, PATH: "", OAR_ANTIGRAVITY_BIN: null };
  await expect(antigravityRuntime.installation({ env })).resolves.toEqual({ kind: "available", via: "executable", command, version: "1.4.12" });
  await expect(antigravityRuntime.installation({ env: { ...env, OAR_ANTIGRAVITY_BIN: path.join(dir, "missing") } })).resolves.toEqual({ kind: "not_found" });
});

async function runCliTurns(
  installation: Parameters<typeof antigravityRuntime.session>[0],
  options: Parameters<typeof antigravityRuntime.session>[1],
  inputs: readonly string[],
): Promise<string> {
  const session = await antigravityRuntime.session(installation, options);
  try {
    // The effort fixture reports fixture-model-x: read native state, not the requested id.
    expect(session.model().value).toBe("fixture-model-x");
    expect(session.effort().value).toBe("high");
    for (const input of inputs) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Turns on one session must be sequential.
      expect(await promptAndWait(session, input)).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    }
    return session.id;
  } finally {
    await session.dispose();
  }
}

test("runtime entrypoint starts a pinned CLI with acp, reads applied settings, runs turns and resumes", async () => {
  const command = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
  renameSync(fakeAgentBinary(dir, [path.join(import.meta.dirname, "../fixtures/fake-antigravity-cli.mjs")]), command);
  const installation = await antigravityRuntime.installation({ env: { OAR_ANTIGRAVITY_BIN: command } });
  expect(installation).toEqual({ kind: "available", via: "executable", command, version: "1.4.12" });
  if (installation.kind !== "available") { throw new Error("fixture CLI unavailable"); }
  const options = { cwd: dir, model: "requested-y", effort: "high" };
  const id = await runCliTurns(installation, options, ["one", "two"]);
  expect(await runCliTurns(installation, { ...options, resume: id }, ["three"])).toBe(id);
});
