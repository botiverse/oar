import { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { refuseChangedPiReaderEnvironment } from "../../packages/oar/src/runtimes/pi/reader-environment.js";

const sdk = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ listProviders: async () => [] })),
  tools: vi.fn(async () => ({ kind: "ok", items: [] })),
  skills: vi.fn(async () => ({ kind: "ok", partial: false, items: [{ name: "sdk-skill", disableModelInvocation: true }] })),
  commands: vi.fn(async () => ({ kind: "ok", partial: false, items: [{ name: "sdk-prompt", argumentHint: "<file>" }] })),
  models: vi.fn(async () => ({ kind: "ok", models: [{ id: "sdk/model", default: true, provider: { id: "sdk", displayName: "SDK provider" } }] })),
}));
vi.mock("node:child_process", async (original) => ({ ...await original<object>(), spawn: vi.fn(() => { throw new Error("Unexpected subprocess"); }) }));
vi.mock("../../packages/oar/src/runtimes/pi/auth.js", () => ({ createPiProviderAuth: sdk.auth }));
vi.mock("../../packages/oar/src/runtimes/pi/inventory.js", () => ({ createPiInventories: () => ({ tools: sdk.tools, skills: sdk.skills, commands: sdk.commands }) }));
vi.mock("../../packages/oar/src/runtimes/pi/list-models.js", async (original) => ({ ...await original<object>(), piModelLister: () => sdk.models }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
const installed = { kind: "available", via: "bundled" } as const;

// oxlint-disable-next-line max-statements -- All three readers must retain SDK metadata and avoid native process startup.
test.each([undefined, {}, { OAR_PI_READER_SAME: "same", OAR_PI_READER_ABSENT: null }])("unchanged env %j retains SDK readers without spawning", async (env) => {
  vi.stubEnv("OAR_PI_READER_SAME", "same");
  vi.stubEnv("OAR_PI_READER_ABSENT", undefined);
  const runtime = createPiRuntime({ execution: "subprocess" });
  const options = env === undefined ? {} : { env };
  await expect(runtime.skills(installed, options)).resolves.toMatchObject({ partial: false, items: [{ disableModelInvocation: true }] });
  await expect(runtime.commands(installed, options)).resolves.toMatchObject({ partial: false, items: [{ argumentHint: "<file>" }] });
  await expect(runtime.listModels(installed, options)).resolves.toMatchObject({ models: [{ default: true, provider: { displayName: "SDK provider" } }] });
  for (const reader of [sdk.skills, sdk.commands, sdk.models]) {
    expect(reader).toHaveBeenCalledExactlyOnceWith(installed, options);
  }
  expect(spawn).not.toHaveBeenCalled();
});

// oxlint-disable-next-line max-statements -- Both native entry points, privacy and unchanged host state form the refusal regression.
test.each(["private-new-value", null])("RPC host-only readers reject actual env changes (%s) before invoking the SDK", async (value) => {
  vi.stubEnv("OAR_PI_READER_SECRET", "private-host-value");
  const runtime = createPiRuntime({ execution: "subprocess" });
  const env = { OAR_PI_READER_SECRET: value };
  const results = await Promise.allSettled([
    runtime.tools(installed, { env }), runtime.providers?.(installed, { env, resolve: false }),
  ]);
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") { throw new Error("expected refusal"); }
    expect(result.reason).toBeInstanceOf(UnsupportedOptionError);
    expect(result.reason).toMatchObject({ option: "env" });
    expect(String(result.reason)).toContain("OAR_PI_READER_SECRET");
    expect(String(result.reason)).not.toContain("private-");
  }
  expect(sdk.auth).not.toHaveBeenCalled();
  expect(sdk.tools).not.toHaveBeenCalled();
  expect(process.env.OAR_PI_READER_SECRET).toBe("private-host-value");
});

test("RPC host-only readers accept omission, empty overlays, equal values and absent removals", async () => {
  vi.stubEnv("OAR_PI_READER_SAME", "same");
  vi.stubEnv("OAR_PI_READER_ABSENT", undefined);
  const runtime = createPiRuntime({ execution: "subprocess" });
  for (const env of [undefined, {}, { OAR_PI_READER_SAME: "same", OAR_PI_READER_ABSENT: null }]) {
    const options = env === undefined ? {} : { env };
    // oxlint-disable-next-line no-await-in-loop -- Check each overlay's independent native fallback.
    await expect(runtime.tools(installed, options)).resolves.toMatchObject({ kind: "ok" });
    // oxlint-disable-next-line no-await-in-loop -- Check each overlay's independent native fallback.
    await expect(runtime.providers?.(installed, { ...options, resolve: false })).resolves.toEqual([]);
  }
  expect(sdk.auth).toHaveBeenCalledTimes(3);
  expect(sdk.tools).toHaveBeenCalledTimes(3);
});

test("in-process readers retain their session's Bash-only environment semantics", async () => {
  const runtime = createPiRuntime();
  const env = { HOME: "bash-only-home", OAR_PI_READER_SECRET: "bash-only-secret" };
  await expect(runtime.tools(installed, { env })).resolves.toMatchObject({ kind: "ok" });
  await expect(runtime.providers?.(installed, { env, resolve: false })).resolves.toEqual([]);
  expect(sdk.tools).toHaveBeenCalledWith(installed, { env });
  expect(sdk.auth).toHaveBeenCalledOnce();
});

test.skipIf(process.platform !== "win32")("the changed-value guard uses Windows case-insensitive names", () => {
  vi.stubEnv("OAR_PI_READER_CASE", "same");
  expect(() => { refuseChangedPiReaderEnvironment({ oar_pi_reader_case: "same" }); }).not.toThrow();
  expect(() => { refuseChangedPiReaderEnvironment({ oar_pi_reader_case: null }); }).toThrow(UnsupportedOptionError);
});
