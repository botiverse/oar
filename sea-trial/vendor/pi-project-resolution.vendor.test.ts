import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { isPiBackend, piRpc } from "./support/pi-runtime.js";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { checkPiProjectPackages } from "../../packages/oar/src/runtimes/pi/project.js";
import { piProjectFixture } from "./support/pi-project.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe.skipIf(!isPiBackend)("Pi native project package resolution", () => {
  test.each(["installed", "missing", "mismatched"] as const)("autoload delta uses its %s user package", async (state) => {
    const fixture = await piProjectFixture(state);
    for (const [key, value] of Object.entries(fixture.env)) { vi.stubEnv(key, value); }
    vi.stubEnv("PI_OFFLINE", "");
    const source = path.join(fixture.cwd, ".pi/npm/node_modules/oar-fixture-package");
    if (state !== "missing") {
      await cp(source, path.join(fixture.agentDir, "npm/node_modules/oar-fixture-package"), { recursive: true });
      await rm(source, { recursive: true });
    }
    const settingsPath = path.join(fixture.cwd, ".pi/settings.json");
    const settings = asRecord(JSON.parse(await readFile(settingsPath, "utf8")));
    await writeFile(settingsPath, JSON.stringify({ ...settings, packages: [{ source: "npm:oar-fixture-package@2.0.0", autoload: false }] }));
    await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:oar-fixture-package@1.0.0"] }));
    try {
      const opening = createPiRuntime({ execution: piRpc ? "subprocess" : "in-process" }).session({ kind: "available", via: "bundled" }, { cwd: fixture.cwd });
      if (state === "installed") { const session = await opening; await session.dispose(); }
      else { await expect(opening).rejects.toMatchObject({ name: "RuntimeFailureError", code: "project_packages_blocked" }); }
      expect(existsSync(fixture.installed)).toBe(false);
      expect(existsSync(fixture.loaded)).toBe(state === "installed");
      expect(existsSync(fixture.projectLoaded)).toBe(state === "installed");
      expect(existsSync(path.join(fixture.agentDir, "trust.json"))).toBe(false);
      const after: unknown = JSON.parse(await readFile(path.join(fixture.agentDir, "settings.json"), "utf8"));
      expect(after).toEqual({ packages: ["npm:oar-fixture-package@1.0.0"] });
    } finally { await fixture.stop(); }
  }, 30_000);

  test("the conservative policy also refuses unrelated missing user packages", async () => {
    const fixture = await piProjectFixture("installed");
    for (const [key, value] of Object.entries(fixture.env)) { vi.stubEnv(key, value); }
    vi.stubEnv("PI_OFFLINE", "");
    await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:oar-unrelated-user-package@1.0.0"] }));
    try {
      const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
      const settings = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: true });
      const native = new DefaultPackageManager({ cwd: fixture.cwd, agentDir: fixture.agentDir, settingsManager: settings });
      const missing: string[] = [];
      // oxlint-disable-next-line eslint/require-await, typescript/require-await -- Native callback requires a Promise for a synchronous skip.
      await native.resolve(async (source) => { missing.push(source); return "skip"; });
      expect(missing).toEqual(["npm:oar-unrelated-user-package@1.0.0"]);
      const checking = checkPiProjectPackages(fixture.cwd, fixture.agentDir, settings, {});
      await expect(checking).rejects.toMatchObject({ name: "RuntimeFailureError", code: "project_packages_blocked" });
      await expect(checking).rejects.toThrow('"npm:oar-unrelated-user-package@1.0.0"');
      expect([fixture.installed, fixture.loaded, fixture.projectLoaded].map((file) => existsSync(file))).toEqual([false, false, false]);
    } finally { await fixture.stop(); }
  }, 30_000);
});
