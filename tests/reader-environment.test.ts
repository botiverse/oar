import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createPiRuntime, createCursorRuntime, orient, RuntimeRegistry } from "../packages/oar/src/index.js";
import { executableInstallation } from "../packages/oar/src/shared/installation.js";
import { qoderInstallation } from "../packages/oar/src/runtimes/qoder/installation.js";
import { fakeLoginCli } from "./fixtures/login-fixtures.js";

const dirs: string[] = [];
const bundled = { kind: "available", via: "bundled" } as const;
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); })); });
async function temporary(): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), "oar-reader-env-")); dirs.push(dir); return dir; }
const state = { version: "1.1.78", mode: "success", captureEnv: ["HOME", "OAR_READER_REMOVED"] };

// oxlint-disable-next-line max-statements -- Discovery, version execution and shadowed copies form one observation.
test("installation uses one environment for its override, PATH, version and shadowed copies", async () => {
  const first = await temporary(), second = await temporary();
  const name = `reader-${path.basename(first)}`;
  const a = fakeLoginCli({ dir: first, name, script: "fake-qoder-login.mjs", state });
  const b = fakeLoginCli({ dir: second, name, script: "fake-qoder-login.mjs", state });
  vi.stubEnv("OAR_READER_BIN", "missing-host-only-command"); vi.stubEnv("OAR_READER_REMOVED", "host");
  const before = { pin: process.env.OAR_READER_BIN, removed: process.env.OAR_READER_REMOVED };
  const probe = executableInstallation("OAR_READER_BIN", name, [], ["--version"]);
  const result = await probe({ env: { OAR_READER_BIN: null, PATH: [first, second].join(path.delimiter), HOME: first, OAR_READER_REMOVED: null, ...(process.platform === "win32" ? { PATHEXT: ".cmd" } : {}) } });
  expect(result).toEqual({ kind: "available", via: "executable", command: a.command, version: "1.1.78", shadowed: [b.command] });
  expect(a.read().environments).toEqual(Array.from({ length: 2 }, () => ({ args: ["--version"], environment: { HOME: first, OAR_READER_REMOVED: null } })));
  expect({ pin: process.env.OAR_READER_BIN, removed: process.env.OAR_READER_REMOVED }).toEqual(before);
});

test.skipIf(process.platform === "win32")("fallback HOME is evaluated on each call using the overlay", async () => {
  for (const home of [await temporary(), await temporary()]) {
    const bin = path.join(home, ".local", "bin");
    // oxlint-disable-next-line no-await-in-loop -- Repeated calls verify that fallback discovery is not cached.
    await mkdir(bin, { recursive: true });
    const fake = fakeLoginCli({ dir: bin, name: "qodercli", script: "fake-qoder-login.mjs", state });
    // oxlint-disable-next-line no-await-in-loop -- Repeated calls verify that fallback discovery is not cached.
    const found = await qoderInstallation({ env: { HOME: home, PATH: "", OAR_QODER_BIN: null } });
    expect(found).toEqual({ kind: "available", via: "executable", command: fake.command, version: "1.1.78" });
  }
});

vi.mock("../packages/oar/src/runtimes/pi/auth.js", () => ({
  createPiProviderAuth: async () => ({ listProviders: async () => [] }),
}));

test.each([undefined, "subprocess"] as const)("Pi %s installation accepts env and orient reports its bundled installation", async (execution) => {
  const pi = createPiRuntime(execution === undefined ? {} : { execution });
  const options = { env: { HOME: "unused-for-host-sdk", OAR_PI_AGENT_DIR: null } };
  const before = { home: process.env.HOME, agent: process.env.OAR_PI_AGENT_DIR };
  await expect(pi.installation(options)).resolves.toEqual(bundled);
  const result = await orient(new RuntimeRegistry([pi]), options);
  expect(result.runtimes[0]?.installation).toMatchObject({ kind: "ok", value: bundled });
  expect(result.runtimes[0]?.providers).toMatchObject(execution === "subprocess" ? { kind: "unsupported" } : { kind: "ok", value: [] });
  expect({ home: process.env.HOME, agent: process.env.OAR_PI_AGENT_DIR }).toEqual(before);
});

test("Cursor model and installation readers reject env without loading the SDK", async () => {
  const sdk = vi.fn(async () => { throw new Error("must not load"); });
  const cursor = createCursorRuntime({ sdk });
  await expect(cursor.installation({ env: { HOME: null } })).rejects.toMatchObject({ option: "env" });
  await expect(cursor.listModels(bundled, { env: { HOME: null } })).rejects.toMatchObject({ option: "env" });
  expect(sdk).not.toHaveBeenCalled();
});
