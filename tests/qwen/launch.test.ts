import { afterEach, expect, test, vi } from "vitest";
import { launchQwen } from "../../packages/oar/src/runtimes/qwen/launch.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

test("launchQwen passes fresh session ids in --flag=value form", async () => {
  const fresh = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fresh);
  await launchQwen("qwen", "new-uuid", { cwd: "/work" });
  expect(spawnLineProcess.mock.calls[0]?.[1]).toContain("--session-id=new-uuid");
  fresh.end(0);
});

test("launchQwen passes resumed session ids in --flag=value form and refuses dash-leading resume", async () => {
  const resumed = fakeLineProcess();
  spawnLineProcess.mockReturnValue(resumed);
  await launchQwen("qwen", "saved-uuid", { cwd: "/work", resume: "saved-uuid" });
  expect(spawnLineProcess.mock.calls[0]?.[1]).toContain("--resume=saved-uuid");
  resumed.end(0);

  spawnLineProcess.mockReset();
  await expect(launchQwen("qwen", "-c", { cwd: "/work", resume: "-c" })).rejects.toMatchObject({
    name: "UnsupportedOptionError",
    option: "resume",
  });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
