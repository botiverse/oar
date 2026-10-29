import { expect, test, vi } from "vitest";
import { defineRuntime, UnsupportedOptionError, claudeRuntime, qwenRuntime, qoderRuntime, codexRuntime, codebuddyRuntime, opencodeRuntime, type AvailableInstallation } from "../packages/oar/src/index.js";
import { createPiRuntime } from "../packages/oar/src/runtimes/pi/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";
import { pooledMockRuntime } from "../sea-trial/fixtures/pooled-mock-runtime.js";
import { trialCases } from "../sea-trial/cases/suite.js";
import { runSuite } from "../sea-trial/harness/runner.js";
import { runtimeUnderTest } from "../sea-trial/harness/subject.js";

const installation: AvailableInstallation = { kind: "available", via: "executable", command: "/mock", version: "unverified" };
const bundled: AvailableInstallation = { kind: "available", via: "bundled" };

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("version gates decide at open; auto falls back and explicit shared refuses before starting", async () => {
  const isolated = vi.fn(startMockSession);
  const shared = vi.fn(startMockSession);
  const factory = vi.fn(() => shared);
  const runtime = defineRuntime({ id: "gated", session: isolated }, { execution: "process", shared: {
    refusal: (value) => value.via === "executable" && value.version === "verified" ? null : "version gate not passed",
    session: factory,
  } });
  const explicit = runtime.withPlacement("shared");
  expect(runtime.placement).toBe("auto"); expect(explicit.placement).toBe("shared");
  expect(factory).not.toHaveBeenCalled();
  await expect(explicit.session(installation, { cwd: "." })).rejects.toBeInstanceOf(UnsupportedOptionError);
  expect(isolated).not.toHaveBeenCalled(); expect(shared).not.toHaveBeenCalled();
  const a = await runtime.session(installation, { cwd: "." });
  expect(a.placement).toBe("isolated");
  expect(a.records().slice(0, 2).map((record) => record.body)).toEqual([{ kind: "open", placement: "auto" }, { kind: "opened", placement: "isolated" }]);
  const verified = { ...installation, version: "verified" };
  const b = await runtime.session(verified, { cwd: "." });
  const c = await runtime.session(verified, { cwd: "." });
  expect(b.placement).toBe("shared"); expect(c.placement).toBe("shared");
  expect(factory).toHaveBeenCalledTimes(1);
  const d = await explicit.session(verified, { cwd: "." });
  expect(factory).toHaveBeenCalledTimes(2);
  expect(d.records()[0]?.body).toEqual({ kind: "open", placement: "shared" });
  const e = await runtime.withPlacement("isolated").session(verified, { cwd: "." });
  expect(e.placement).toBe("isolated");
  await Promise.all([a, b, c, d, e].map(async (session) => { await session.dispose(); }));
});

test("in-process runtimes report their actual placement and refuse a separate process", async () => {
  const open = vi.fn(startMockSession);
  const runtime = defineRuntime({ id: "sdk", session: open }, { execution: "in_process" });
  const session = await runtime.session(bundled, { cwd: "." });
  expect(session.placement).toBe("in_process");
  await expect(runtime.withPlacement("isolated").session(bundled, { cwd: "." })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
  await expect(runtime.withPlacement("shared").session(bundled, { cwd: "." })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
  expect(open).toHaveBeenCalledTimes(1);
  await session.dispose();
});

test("explicit isolation does not consult the shared version gate", async () => {
  const refusal = vi.fn(() => { throw new Error("shared gate must not run"); });
  const factory = vi.fn(() => startMockSession);
  const runtime = defineRuntime({ id: "gated", session: startMockSession }, { execution: "process", shared: { refusal, session: factory } });
  const session = await runtime.withPlacement("isolated").session(installation, { cwd: "." });
  expect(session.placement).toBe("isolated");
  expect(refusal).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  await session.dispose();
});

test.each([claudeRuntime, qwenRuntime, qoderRuntime, codexRuntime, codebuddyRuntime, opencodeRuntime, createPiRuntime({ execution: "subprocess" })])("native $id sharing remains disabled in Phase 1", async (runtime) => {
  await expect(runtime.withPlacement("shared").session(installation, { cwd: "." })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
});

test("an undeclared custom adapter cannot silently accept a placement it cannot prove", async () => {
  const open = vi.fn(startMockSession);
  const runtime = defineRuntime({ id: "custom", session: open });
  await expect(runtime.withPlacement("isolated").session(bundled, { cwd: "." })).rejects.toBeInstanceOf(UnsupportedOptionError);
  expect(open).not.toHaveBeenCalled();
});

test.each(["shared", "isolated"] as const)("the complete behavior suite passes with the %s mock", async (placement) => {
  const outcomes = await runSuite(trialCases, runtimeUnderTest(pooledMockRuntime().withPlacement(placement)));
  expect(outcomes.filter((outcome) => outcome.kind === "fail")).toEqual([]);
  expect(outcomes.filter((outcome) => outcome.kind === "pass").length).toBeGreaterThan(15);
}, 30_000);

test("another runtime instance cannot keep the first instance's process alive", async () => {
  const runtime = pooledMockRuntime();
  const one = await runtime.session(bundled, { cwd: "." });
  const two = await runtime.withPlacement("auto").session(bundled, { cwd: "." });
  await one.dispose();
  expect(one.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(true);
  expect(two.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(false);
  await two.dispose();
});
