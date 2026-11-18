import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { dshRuntime } from "../../packages/oar/src/runtimes/dsh/index.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const cwd = mkdtempSync(path.join(tmpdir(), "oar-dsh-skills-unit-"));
const command = fakeAgentBinary(cwd, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
const installation = { kind: "available", via: "executable", command, version: "0.2.1-rc.5" } as const;
afterAll(() => { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

test("skills uses the native bridge with the requested cwd and environment, without copying bodies", async () => {
  const result = await dshRuntime.skills(installation, { cwd, env: { OAR_SKILL_DESCRIPTION: "native description", FAKE_DSH_MISSING: "create,resume" } });
  expect(result).toMatchObject({ kind: "ok", scope: { kind: "workspace", cwd }, view: "discovered", partial: false,
    items: [{ name: "fixture", path: cwd, source: "project-dsh", scope: "project", description: "native description", userInvocable: true, disableModelInvocation: true }] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SKILL_BODY");
  if (result.kind === "ok") { expect(result.items[0]).not.toHaveProperty("plugin"); }
});

test.each([true, false])("native complete=%s controls partial without dropping entries", async (complete) => {
  const skills = ["bundled", "user-dsh", "user-agents", "project-dsh", "project-agents", "custom", "runtime", "future"].map(source => ({ name: source, source }));
  const result = await dshRuntime.skills(installation, { cwd, env: { FAKE_DSH_SKILLS: JSON.stringify({ skills, complete }) } });
  assert.equal(result.kind, "ok");
  expect(result.partial).toBe(!complete);
  expect(result.items).toEqual([
    { name: "bundled", source: "bundled", scope: "builtin" }, { name: "user-dsh", source: "user-dsh", scope: "user" },
    { name: "user-agents", source: "user-agents", scope: "user" }, { name: "project-dsh", source: "project-dsh", scope: "project" },
    { name: "project-agents", source: "project-agents", scope: "project" }, { name: "custom", source: "custom", scope: "other" },
    { name: "runtime", source: "runtime", scope: "other" }, { name: "future", source: "future" },
  ]);
});

test.each([{}, { skills: [], complete: "true" }, { skills: [null], complete: true }, { skills: [{}], complete: true }])("malformed snapshot is unavailable: %j", async (snapshot) => {
  await expect(dshRuntime.skills(installation, { cwd, env: { FAKE_DSH_SKILLS: JSON.stringify(snapshot) } })).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
});

test("missing native snapshot is unsupported", async () => {
  await expect(dshRuntime.skills(installation, { cwd, env: { FAKE_DSH_MISSING: "snapshot" } })).resolves.toMatchObject({ kind: "unsupported", code: "native_query_unavailable" });
});

test("native error text stays private", async () => {
  await expect(dshRuntime.skills(installation, { cwd, env: { FAKE_DSH_MODE: "skills-error" } })).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
});

test("deadline bounds a native provider which never settles", async () => {
  await expect(dshRuntime.skills(installation, { cwd, env: { FAKE_DSH_MODE: "skills-hang" }, timeoutMs: 500 })).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
});

test.each([0, -1, Infinity, NaN])("invalid deadline rejects before launch: %s", async (timeoutMs) => {
  await expect(dshRuntime.skills(installation, { cwd, timeoutMs })).rejects.toThrow(RangeError);
});

test("unreadable or below-floor versions and bundled installation are refused", async () => {
  await expect(dshRuntime.skills({ ...installation, version: "0.2.1-rc.4" }, { cwd })).resolves.toMatchObject({ kind: "unsupported", code: "version_unsupported" });
  await expect(dshRuntime.skills({ ...installation, version: "nightly" }, { cwd })).resolves.toMatchObject({ kind: "unsupported", code: "version_unsupported" });
  await expect(dshRuntime.skills({ kind: "available", via: "bundled" }, { cwd })).resolves.toMatchObject({ kind: "unsupported", code: "installation_unsupported" });
});

test("DSH preserves user invocation independently of model invocation and missing metadata", async () => {
  const skills = [{ name: "hidden", invocation: { userInvocable: false, modelInvocable: true } },
    { name: "manual", invocation: { userInvocable: true, modelInvocable: false } },
    { name: "absent" }, { name: "invalid", invocation: { userInvocable: "false" } }];
  const result = await dshRuntime.skills(installation, { cwd, env: { FAKE_DSH_SKILLS: JSON.stringify({ skills, complete: true }) } });
  assert.equal(result.kind, "ok");
  expect(result.items).toEqual([{ name: "hidden", userInvocable: false, disableModelInvocation: false },
    { name: "manual", userInvocable: true, disableModelInvocation: true }, { name: "absent" }, { name: "invalid" }]);
});
