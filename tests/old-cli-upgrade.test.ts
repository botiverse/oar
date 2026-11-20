import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readUpgrade } from "../packages/cli/src/upgrade.js";
import { antigravityRuntime } from "../packages/oar/src/runtimes/antigravity/index.js";
import { fakeRuntime } from "./fixtures/update-fixtures.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); } });

function oldCli(mode: "upgrade" | "noop" | "fail", target = "1.5.9") {
  const root = mkdtempSync(path.join(tmpdir(), "oar-old-upgrade-"));
  roots.push(root);
  const fake = fakeRuntime(root, "agy", { version: "1.4.9", target, mode, bareVersion: true, helpOutput: "Usage of agy:\n  --print-timeout\n" });
  vi.stubEnv("OAR_ANTIGRAVITY_BIN", fake.command);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: target }));
  return fake;
}

// oxlint-disable-next-line eslint/max-statements -- Keep the before/check/update/after regression in one sequence.
test("an old CLI retains its location for checks and upgrade, then clears its floor refusal", async () => {
  const fake = oldCli("upgrade");
  const before = await antigravityRuntime.installation();
  assert.equal(before.kind, "unsupported");
  expect(before).toMatchObject({ code: "version_unsupported", via: "executable", command: fake.command, installedVersion: "1.4.9", requiredVersion: "1.5.0" });
  const check = await readUpgrade(antigravityRuntime, { upgrade: false });
  expect(check.check).toMatchObject({ kind: "ok", installed: "1.4.9", latest: "1.5.9", updateAvailable: true });
  expect(fake.read().updateArgs).toBeUndefined();
  const result = await readUpgrade(antigravityRuntime, { upgrade: true });
  expect(result.upgrade).toMatchInlineSnapshot(`
    {
      "from": "1.4.9",
      "kind": "upgraded",
      "output": "Updated to 1.5.9
    ",
      "to": "1.5.9",
    }
  `);
  expect(fake.read().updateArgs).toEqual([]);
  expect(await antigravityRuntime.installation()).toEqual({ kind: "available", via: "executable", command: fake.command, version: "1.5.9" });
});

test.each(["noop", "fail"] as const)("an old CLI stays refused when its updater does not move it: %s", async (mode) => {
  oldCli(mode);
  const result = await readUpgrade(antigravityRuntime, { upgrade: true });
  expect(result.upgrade?.kind).toBe(mode === "noop" ? "unchanged" : "failed");
  expect(await antigravityRuntime.installation()).toMatchObject({ kind: "unsupported", code: "version_unsupported", installedVersion: "1.4.9" });
});


test("an old refusal uses the executable's fresh version before deciding to update again", async () => {
  oldCli("upgrade");
  const before = await antigravityRuntime.installation();
  assert.equal(before.kind, "unsupported");
  assert.equal(before.code, "version_unsupported");
  const first = await antigravityRuntime.upgrade(before);
  expect(first.kind).toBe("upgraded");
  expect(await antigravityRuntime.upgrade(before)).toMatchObject({ kind: "current", version: "1.5.9" });
});

test("a native upgrade below the floor does not turn discovery into availability", async () => {
  oldCli("upgrade", "1.4.10");
  const result = await readUpgrade(antigravityRuntime, { upgrade: true });
  expect(result.upgrade).toMatchObject({ kind: "upgraded", from: "1.4.9", to: "1.4.10" });
  expect(await antigravityRuntime.installation()).toMatchObject({ kind: "unsupported", code: "version_unsupported", installedVersion: "1.4.10" });
});
