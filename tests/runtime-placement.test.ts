import { expect, test, vi } from "vitest";
import { defineRuntime, UnsupportedOptionError, defaultRuntimes, createCursorRuntime, type AvailableInstallation } from "../packages/oar/src/index.js";
import { createPiRuntime } from "../packages/oar/src/runtimes/pi/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";
import { pooledMockRuntime } from "../sea-trial/fixtures/pooled-mock-runtime.js";
import { trialCases } from "../sea-trial/cases/suite.js";
import { runSuite } from "../sea-trial/harness/runner.js";
import { runtimeUnderTest } from "../sea-trial/harness/subject.js";

const installation: AvailableInstallation = { kind: "available", via: "executable", command: "/mock", version: "unverified" };
const bundled: AvailableInstallation = { kind: "available", via: "bundled" };

test("sharing requires an explicit process declaration, including for JavaScript callers", () => {
  const definition = { id: "custom", session: startMockSession };
  const shared = { refusal: () => null, session: () => startMockSession };
  // @ts-expect-error Shared hooks cannot imply an undeclared process mode.
  expect(() => defineRuntime(definition, { shared })).toThrow("Shared placement requires execution: process");
  // @ts-expect-error In-process SDK execution cannot have shared process hooks.
  expect(() => defineRuntime(definition, { execution: "in_process", shared })).toThrow("Shared placement requires execution: process");
});

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
  expect([runtime.execution, explicit.execution]).toEqual(["process", "process"]);
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
  expect([runtime.execution, explicit.execution]).toEqual(["process", "process"]);
  await Promise.all([a, b, c, d, e].map(async (session) => { await session.dispose(); }));
});

test("in-process runtimes report their actual placement and refuse a separate process", async () => {
  const open = vi.fn(startMockSession);
  const runtime = defineRuntime({ id: "sdk", session: open }, { execution: "in_process" });
  const selected = runtime.execution === "process" ? runtime.withPlacement("isolated") : runtime;
  const session = await selected.session(bundled, { cwd: "." });
  expect(runtime.execution).toBe("in_process");
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
  const selected = runtime.execution === "process" ? runtime.withPlacement("isolated") : runtime;
  const session = await selected.session(installation, { cwd: "." });
  expect(session.placement).toBe("isolated");
  expect(refusal).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  await session.dispose();
});

test.each([...defaultRuntimes.list().filter((runtime) => runtime.id !== "pi"), createPiRuntime({ execution: "subprocess" })])("native $id declares process execution and sharing remains disabled in Phase 1", async (runtime) => {
  expect(runtime.execution).toBe("process");
  for (const placement of ["auto", "shared", "isolated"] as const) {
    expect(runtime.withPlacement(placement).execution).toBe("process");
  }
  await expect(runtime.withPlacement("shared").session(installation, { cwd: "." })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
});

test("Pi and Cursor declare SDK execution before loading or opening it", () => {
  const sdk = vi.fn(() => { throw new Error("SDK must stay unloaded"); });
  for (const runtime of [createPiRuntime(), createCursorRuntime({ sdk })]) {
    expect(runtime.execution).toBe("in_process");
    for (const placement of ["auto", "shared", "isolated"] as const) {
      expect(runtime.withPlacement(placement).execution).toBe("in_process");
    }
  }
  expect(sdk).not.toHaveBeenCalled();
});

// oxlint-disable-next-line eslint/max-statements -- Check both refused requests and the unchanged auto path against the same adapter.
test("an undeclared custom adapter cannot silently accept a placement it cannot prove", async () => {
  const open = vi.fn(startMockSession);
  const runtime = defineRuntime({ id: "custom", session: open });
  expect(runtime.execution).toBeNull();
  await Promise.all((["shared", "isolated"] as const).map(async (placement) => {
    const selected = runtime.withPlacement(placement);
    expect(selected.execution).toBeNull();
    await expect(selected.session(bundled, { cwd: "." })).rejects.toBeInstanceOf(UnsupportedOptionError);
  }));
  expect(open).not.toHaveBeenCalled();
  const selected = runtime.execution === "process" ? runtime.withPlacement("isolated") : runtime;
  expect(selected).toBe(runtime);
  const session = await selected.session(bundled, { cwd: "." });
  expect(open.mock.calls[0]?.[2]).toBeUndefined();
  await session.dispose();
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
