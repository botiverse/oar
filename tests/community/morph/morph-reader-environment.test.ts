import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../../packages/oar/src/contracts/errors.js";
import type { SessionOptions } from "../../../packages/oar/src/contracts/session-options.js";
import { morphInstallation } from "../../../packages/oar/src/community/morph/installation.js";
import { morphListModels } from "../../../packages/oar/src/community/morph/list-models.js";

const native = vi.hoisted(() => ({
  installation: vi.fn(async () => ({ kind: "available", via: "executable", command: "morph", version: "test" })),
  acquire: vi.fn(),
  stateDir: vi.fn(() => "host-state"),
  request: vi.fn(async () => ({ default: { name: "default", model: "test-model" } })),
  release: vi.fn(async () => undefined),
}));
vi.mock("../../../packages/oar/src/shared/installation.js", () => ({ executableInstallation: () => native.installation }));
vi.mock("../../../packages/oar/src/community/morph/console.js", () => ({ acquireConsole: native.acquire, morphStateDir: native.stateDir }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

const installed = { kind: "available", via: "executable", command: "morph" } as const;
const read = async (env?: SessionOptions["env"]): Promise<unknown[]> => Promise.all([
  morphInstallation(env === undefined ? undefined : { env }),
  morphListModels(installed, env === undefined ? undefined : { env }),
]);

test.each(["changed", null, "host"] as const)("both readers refuse nonempty env (%s) before native I/O", async (value) => {
  vi.stubEnv("OAR_MORPH_TEST_SECRET", "host");
  const env = { OAR_MORPH_TEST_SECRET: value };
  for (const query of [() => morphInstallation({ env }), () => morphListModels(installed, { env })]) {
    // oxlint-disable-next-line no-await-in-loop -- Inspect each reader's own refusal before any I/O.
    const error = await query().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error).toMatchObject({ option: "env" });
    expect(String(error)).not.toContain("OAR_MORPH_TEST_SECRET");
  }
  expect(native.installation).not.toHaveBeenCalled();
  expect(native.stateDir).not.toHaveBeenCalled();
  expect(native.acquire).not.toHaveBeenCalled();
  expect(process.env.OAR_MORPH_TEST_SECRET).toBe("host");
});

test.each([undefined, {}])("omitted and empty env preserve host discovery and release the model reader's lease (%j)", async (env) => {
  native.acquire.mockResolvedValue({ client: { expect: native.request }, release: native.release });
  const result = await read(env);
  expect(result).toEqual([
    { ...installed, version: "test" },
    { kind: "ok", models: [{ id: "default", resolvedId: "test-model" }] },
  ]);
  expect(native.installation).toHaveBeenCalledOnce();
  expect(native.acquire).toHaveBeenCalledExactlyOnceWith("morph", "host-state");
  expect(native.request).toHaveBeenCalledExactlyOnceWith("GET", "/llm/profiles");
  expect(native.release).toHaveBeenCalledOnce();
});
