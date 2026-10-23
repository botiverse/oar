import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { qwenInstallMethod } from "../../packages/oar/src/runtimes/qwen/install.js";
import { scriptInstallPlanOn } from "../../packages/oar/src/shared/install.js";

afterEach(() => { vi.unstubAllEnvs(); });

test("privilege checks honor library staging and binary directory overrides", () => {
  const root = path.resolve("host-owned");
  const library = path.join(root, "library", "custom-qwen");
  const bin = path.join(root, "executables");
  for (const [key, value] of Object.entries({ QWEN_INSTALL_ROOT: path.resolve("unused-root"), QWEN_INSTALL_LIB_PARENT: path.resolve("unused-parent"), QWEN_INSTALL_LIB_DIR: library, QWEN_INSTALL_BIN_DIR: bin })) {
    vi.stubEnv(key, value);
  }
  const checked: string[] = [];
  const plan = scriptInstallPlanOn(qwenInstallMethod, {
    platform: "linux", arch: "x64", locate: (tool) => `/usr/bin/${tool}`,
    unwritable: (target) => { checked.push(target); return target === path.dirname(library) ? target : null; },
  });
  expect(checked).toEqual([bin, path.dirname(library)]);
  expect(plan.kind === "unsupported" ? plan.reason : plan.kind).toBe("requires_privileges");
});

test("Windows gives official instructions without attempting a shell installer", () => {
  const probe = vi.fn(() => null);
  const plan = scriptInstallPlanOn(qwenInstallMethod, { platform: "win32", arch: "x64", locate: probe, unwritable: probe });
  expect(plan.kind === "unsupported" ? plan.reason : plan.kind).toBe("platform");
  expect(probe).not.toHaveBeenCalled();
});
