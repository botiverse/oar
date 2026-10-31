import { afterEach, expect, test, vi } from "vitest";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { prepareProcessTable } from "../packages/oar/src/shared/executable/process-table-preparation.js";

vi.mock("../packages/oar/src/shared/executable/process-table-preparation.js", () => ({ prepareProcessTable: vi.fn(), processTablePreparation: () => undefined }));
afterEach(() => { vi.clearAllMocks(); });

test("only a successfully spawned tree-owning line process triggers preparation", async () => {
  const ordinary = spawnLineProcess(process.execPath, ["-e", "process.exit(0)"]);
  await ordinary.spawned; await ordinary.exited;
  expect(prepareProcessTable).not.toHaveBeenCalled();
  const owned = spawnLineProcess(process.execPath, ["-e", "process.exit(0)"], { killTree: true });
  await owned.spawned; await owned.exited;
  expect(prepareProcessTable).toHaveBeenCalledOnce();
});

test("a failed spawn does not consume first-use preparation", async () => {
  const child = spawnLineProcess("oar-no-such-executable-for-preparation", [], { killTree: true });
  await expect(child.spawned).rejects.toThrow(); await child.exited;
  expect(prepareProcessTable).not.toHaveBeenCalled();
});

test("short executable queries do not trigger long-lived process preparation", async () => {
  const result = await runExecutable(process.execPath, ["--version"]);
  expect(result.ok).toBe(true);
  expect(prepareProcessTable).not.toHaveBeenCalled();
});
