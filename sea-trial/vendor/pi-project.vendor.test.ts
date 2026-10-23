import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { RuntimeFailureError } from "../../packages/oar/src/contracts/runtime-failure-error.js";
import { piProjectFixture, type PackageState } from "./support/pi-project.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const cases = (["none", "installed", "missing", "mismatched"] as const).flatMap((state) =>
  (["default", "offline", "allow"] as const).map((mode) => ({ state, mode })));

describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("Pi native project policy", () => {
  test.each(cases)("$state package in $mode mode", async ({ state, mode }) => {
    const fixture = await piProjectFixture(state);
    for (const [key, value] of Object.entries(fixture.env)) { vi.stubEnv(key, value); }
    vi.stubEnv("PI_OFFLINE", mode === "offline" ? "1" : "");
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const opening = createPiRuntime({ allowProjectPackageInstall: mode === "allow" }).session({ kind: "available", via: "bundled" }, { cwd: fixture.cwd });
      const refused = mode === "default" && (state === "missing" || state === "mismatched");
      if (refused) {
        const refusal = await opening.then(async (session) => { await session.dispose(); return null; }, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(RuntimeFailureError);
        expect(refusal).toMatchObject({ failure: "invalid_request", code: "project_packages_blocked" });
        expect(refusal).not.toHaveProperty("option");
      }
      else { const session = await opening; await session.dispose(); }
      expect(existsSync(fixture.installed)).toBe(mode === "allow" && (state === "missing" || state === "mismatched"));
      expect(existsSync(fixture.loaded)).toBe(!refused && state !== "none" && (state === "installed" || mode === "allow"));
      expect(existsSync(fixture.projectLoaded)).toBe(!refused);
      expect(existsSync(path.join(fixture.agentDir, "trust.json"))).toBe(false);
      const missing = warning.mock.calls.some((call) => typeof call[1] === "object" && call[1].code === "OAR_PI_PACKAGE_MISSING");
      expect(missing).toBe(mode === "offline" && state === "missing");
      expect(process.env.PI_OFFLINE).toBe(mode === "offline" ? "1" : "");
    } finally { await fixture.stop(); }
  }, 30_000);

  test("whitespace around PI_OFFLINE does not permit native package installation", async () => {
    const fixture = await piProjectFixture("missing");
    for (const [key, value] of Object.entries(fixture.env)) { vi.stubEnv(key, value); }
    vi.stubEnv("PI_OFFLINE", " 1 ");
    try {
      const opening = createPiRuntime().session({ kind: "available", via: "bundled" }, { cwd: fixture.cwd });
      await expect(opening.then(async (session) => { await session.dispose(); return null; })).rejects.toBeInstanceOf(RuntimeFailureError);
      expect(existsSync(fixture.installed)).toBe(false);
    } finally { await fixture.stop(); }
  }, 30_000);

  test.each(["installed", "missing"] satisfies PackageState[])("untrusted %s project neither loads extensions nor installs packages", async (state) => {
    const fixture = await piProjectFixture(state);
    for (const [key, value] of Object.entries(fixture.env)) { vi.stubEnv(key, value); }
    vi.stubEnv("PI_OFFLINE", "");
    const trust = path.join(fixture.agentDir, "trust.json");
    await writeFile(trust, "{}\n");
    try {
      const runtime = createPiRuntime({ projectTrusted: false });
      const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: fixture.cwd });
      await session.dispose();
      const inventory = await runtime.tools({ kind: "available", via: "bundled" }, { cwd: fixture.cwd });
      expect(inventory.kind).toBe("ok");
      expect([fixture.installed, fixture.loaded, fixture.projectLoaded].map((file) => existsSync(file))).toEqual([false, false, false]);
      expect(await readFile(trust, "utf8")).toBe("{}\n");
    } finally { await fixture.stop(); }
  }, 30_000);
});
