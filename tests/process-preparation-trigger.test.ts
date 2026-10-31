import { afterEach, expect, test, vi } from "vitest";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { prepareProcessTable, processTablePreparation } from "../packages/oar/src/shared/executable/process-table-preparation.js";

vi.mock("../packages/oar/src/shared/executable/process-table-preparation.js", () => ({ prepareProcessTable: vi.fn(), processTablePreparation: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.mocked(processTablePreparation).mockReset(); });

test("only a successfully spawned tree-owning line process triggers preparation", async () => {
  const ordinary = spawnLineProcess(process.execPath, ["-e", "process.exit(0)"]);
  await ordinary.spawned; await ordinary.exited;
  expect(prepareProcessTable).not.toHaveBeenCalled();
  const owned = spawnLineProcess(process.execPath, ["-e", "process.exit(0)"], { killTree: true });
  await owned.spawned; await owned.exited;
  expect(prepareProcessTable).toHaveBeenCalledOnce();
});

test("preparation follows actual process startup, including a Windows shell reporting a missing executable", async () => {
  const child = spawnLineProcess("oar-no-such-executable-for-preparation", [], { killTree: true });
  await (process.platform === "win32" ? child.spawned : expect(child.spawned).rejects.toThrow());
  await child.exited;
  expect(prepareProcessTable).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 0);
  expect(child.diagnostics().cleanup).toBeUndefined();
});

test("an OS-level spawn failure does not consume first-use preparation", async () => {
  const child = spawnLineProcess(process.execPath, ["-e", "process.exit(0)"], { killTree: true, cwd: "oar-no-such-directory-for-preparation" });
  await expect(child.spawned).rejects.toThrow(); await child.exited;
  expect(prepareProcessTable).not.toHaveBeenCalled();
});

test("runExecutable queries do not trigger line-process preparation", async () => {
  const result = await runExecutable(process.execPath, ["--version"]);
  expect(result.ok).toBe(true);
  expect(prepareProcessTable).not.toHaveBeenCalled();
});

// oxlint-disable-next-line eslint/max-statements -- Preparation state is sampled only after actual cleanup, then cannot drift with the host's state.
test("only completed cleanup retains a stable preparation diagnostic", async () => {
  vi.mocked(processTablePreparation).mockReturnValue({ status: "pending" });
  const child = spawnLineProcess(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { killTree: true });
  try {
    await child.spawned;
    expect(child.diagnostics()).not.toHaveProperty("processTablePreparation");
    expect(child.diagnostics().cleanup).toBeUndefined();
    child.kill(); await child.exited;
    expect(child.diagnostics().cleanup?.preparation).toEqual({ status: "pending" });
    vi.mocked(processTablePreparation).mockReturnValue({ ok: true, source: "windows", elapsedMs: 1, skipped: 0 });
    expect(child.diagnostics().cleanup?.preparation).toEqual({ status: "pending" });
  } finally { child.kill(); await child.exited; }
});
