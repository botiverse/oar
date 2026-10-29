import { afterEach, expect, test, vi } from "vitest";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { qoderListModels } from "../../packages/oar/src/runtimes/qoder/list-models.js";
import type { SessionOptions, Session } from "../../packages/oar/src/contracts/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const launch = vi.hoisted(() => ({ launchQoder: vi.fn(), closeQoder: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/qoder/launch.js", () => launch);
vi.mock("../../packages/oar/src/runtimes/qoder/auth-status.js", () => ({ qoderAuthStatus: async () => ({ kind: "logged_in" }) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const privateData = { email: "private@example.invalid", username: "private-user", org_id: "private-org", access_token: "fixture-private-token" };
function privateControlProcess() {
  const child = fakeLineProcess((line, process) => {
    const request = asRecord(parseJson(line));
    if (asRecord(request?.request)?.subtype === "initialize") {
      process.emit(`${JSON.stringify({ type: "system", subtype: "init", model: "efficient" })}\n`);
    }
    const payload = asRecord(request?.request)?.subtype === "get_settings"
      ? { sources: { user: privateData }, effective: privateData, applied: { effort: "high", ...privateData } } : privateData;
    process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: payload } })}\n`);
  });
  launch.launchQoder.mockResolvedValue(child);
  launch.closeQoder.mockImplementation(async () => { child.end(0); await child.exited; });
  return child;
}
function expectPrivateDataAbsent(records: string) {
  for (const value of Object.values(privateData)) { expect(records).not.toContain(value); }
  expect(records).not.toContain('"email"');
  expect(records).not.toContain('"org_id"');
}

test("private initialize and settings, including repeated responses, never expose account or configuration", async () => {
  const child = privateControlProcess();
  const session = await qoderSession({ kind: "available", via: "executable", command: "fixture", version: "1.1.78" }, { cwd: "/work", model: "efficient", effort: "high" });
  try {
    const initialize = asRecord(parseJson(child.written[0] ?? ""));
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: initialize?.request_id, response: privateData } })}\n`);
    expect(session.effort().value).toBe("high");
    expectPrivateDataAbsent(JSON.stringify(session.records()));
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

function slowControlProcess(initializeMs: number | null, settingsMs: number | null = 0) {
  const child = fakeLineProcess((line, process) => {
    const request = asRecord(parseJson(line));
    const subtype = asRecord(request?.request)?.subtype;
    const delay = subtype === "initialize" ? initializeMs : settingsMs;
    if (delay === null) { return; }
    setTimeout(() => {
      if (subtype === "initialize") { process.emit(`${JSON.stringify({ type: "system", subtype: "init", model: "efficient" })}\n`); }
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: {} } })}\n`);
    }, delay);
  });
  launch.launchQoder.mockResolvedValue(child);
  launch.closeQoder.mockImplementation(async () => { child.end(0); await child.exited; });
  return child;
}
async function openSlowProcess() {
  const session = await qoderSession({ kind: "available", via: "executable", command: "fixture", version: "1.1.78" }, { cwd: "/work" });
  return session;
}

test("a slow native initialize can finish after the former 30-second deadline", async () => {
  vi.useFakeTimers();
  slowControlProcess(45_000);
  const opening = openSlowProcess();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(launch.closeQoder).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_001);
  const session = await opening;
  try { expect(session.status().value.kind).toBe("idle"); }
  finally { await session.dispose(); }
});

test("a silent initialize still fails and closes its process after 60 seconds", async () => {
  vi.useFakeTimers();
  const child = slowControlProcess(null);
  const rejected = expect(openSlowProcess()).rejects.toThrow("initialize within 60000 ms");
  await vi.advanceTimersByTimeAsync(59_999);
  expect(launch.closeQoder).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(launch.closeQoder).toHaveBeenCalledWith(child);
  expect(await child.exited).toBe(0);
});

test("the longer initialize budget does not extend later controls", async () => {
  vi.useFakeTimers();
  const child = slowControlProcess(1, null);
  const rejected = expect(openSlowProcess()).rejects.toThrow("get_settings within 30000 ms");
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  expect(launch.closeQoder).toHaveBeenCalledWith(child);
});

const catalog = [
  { value: "qfmodel", displayName: "Qwen 3.8 Flash", serverModel: { display_name: "Qwen3.8-Flash", ...privateData } },
  { value: "dfmodel", displayName: "DeepSeek Flash", serverModel: { display_name: "DeepSeek-Flash", ...privateData } },
];
const installation = { kind: "available", via: "executable", command: "fixture", version: "1.1.78" } as const;

function controlPayload(subtype: unknown, models: unknown) {
  if (subtype === "get_models") { return { models, account: privateData }; }
  if (subtype === "get_settings") { return { applied: { effort: "high", ...privateData } }; }
  return privateData;
}

interface CatalogFailure { readonly kind: "silent" | "refused"; readonly strategy: "cache" | "live" }
function failCatalog(child: FakeLineProcess, request: JsonRecord | null, failure?: CatalogFailure) {
  const payload = asRecord(request?.request);
  if (failure === undefined || payload?.subtype !== "get_models" || payload.fetchStrategy !== failure.strategy) { return false; }
  if (failure.kind === "refused") {
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: request?.request_id, error: privateData } })}\n`);
  }
  return true;
}

function catalogProcesses(models: unknown = catalog, reported?: string, queries: { readonly failure?: CatalogFailure; readonly liveModels?: unknown } = {}) {
  const { failure, liveModels = models } = queries;
  const children: FakeLineProcess[] = [];
  launch.launchQoder.mockImplementation(async (_command: string, _id: string, options: SessionOptions) => {
    const child = fakeLineProcess((line, process) => {
      const request = asRecord(parseJson(line));
      const subtype = asRecord(request?.request)?.subtype;
      if (failCatalog(process, request, failure)) { return; }
      if (subtype === "initialize") {
        const model = reported ?? catalog.find((entry) => entry.value === options.model)?.serverModel.display_name ?? "default-model";
        process.emit(`${JSON.stringify({ type: "system", subtype: "init", model })}\n`);
      }
      const rows = asRecord(request?.request)?.fetchStrategy === "live" ? liveModels : models;
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: controlPayload(subtype, rows) } })}\n`);
    });
    children.push(child);
    return child;
  });
  launch.closeQoder.mockImplementation(async (child: FakeLineProcess) => { child.end(0); await child.exited; });
  return children;
}

function expectCatalogReadback(session: Session, resolvedId: string | undefined, child: FakeLineProcess | undefined) {
  expect(session.model().value).toBe(resolvedId);
  expectPrivateDataAbsent(JSON.stringify(session.records()));
  const queries = child?.written.map((line) => asRecord(parseJson(line))?.request);
  expect(queries).toContainEqual({ subtype: "get_models", fetchStrategy: "cache" });
}

async function openListedModel(id: string, resolvedId: string | undefined, children: FakeLineProcess[]) {
  const session = await qoderSession(installation, { cwd: "/work", model: id });
  try { expectCatalogReadback(session, resolvedId, children.at(-1)); }
  finally { await session.dispose(); }
}

function catalogStrategies(child: FakeLineProcess | undefined) {
  return child?.written.map((line) => asRecord(asRecord(parseJson(line))?.request))
    .filter((request) => request?.subtype === "get_models").map((request) => request?.fetchStrategy);
}

test("every listed selector opens while model readback keeps the native name", async () => {
  const children = catalogProcesses();
  const listed = await qoderListModels(installation, { cwd: "/work" });
  expect(listed.kind).toBe("ok");
  if (listed.kind !== "ok") { throw new Error("catalog unavailable"); }
  expect(listed.models.map(({ id }) => id)).toEqual(["qfmodel", "dfmodel"]);
  for (const entry of listed.models) {
    // eslint-disable-next-line no-await-in-loop
    await openListedModel(entry.id, entry.resolvedId, children);
  }
  expect(children).toHaveLength(3);
});

test.each([undefined, "qfmodel"])("model %s needs no catalog when omitted or confirmed directly", async (model) => {
  const children = catalogProcesses([], "qfmodel");
  const session = await qoderSession(installation, { cwd: "/work", ...(model === undefined ? {} : { model }) });
  try {
    expect(session.model().value).toBe("qfmodel");
    expect(children[0]?.written.map((line) => asRecord(asRecord(parseJson(line))?.request)?.subtype)).not.toContain("get_models");
  } finally { await session.dispose(); }
});

test.each([
  { name: "absent selector", models: [], error: "did not contain requested selector", strategies: ["cache", "live"] },
  { name: "display label alone", models: [{ value: "qfmodel", displayName: "Qwen3.8-Flash" }], error: "did not provide a resolved name", strategies: ["cache", "live"] },
  { name: "similar native name", models: [{ value: "qfmodel", serverModel: { display_name: "Qwen 3.8 Flash" } }], error: "did not confirm model", strategies: ["cache"] },
  { name: "another model", models: [{ value: "qfmodel", serverModel: { display_name: "DeepSeek-Flash" } }], error: "did not confirm model", strategies: ["cache"] },
  { name: "native name equal to selector but not init", models: [{ value: "qfmodel", serverModel: { display_name: "qfmodel" } }], error: "did not confirm model", strategies: ["cache"] },
])("$name cannot confirm a model and closes the process", async ({ models, error, strategies }) => {
  const children = catalogProcesses(models, "Qwen3.8-Flash");
  await expect(qoderSession(installation, { cwd: "/work", model: "qfmodel" })).rejects.toThrow(error);
  expect(launch.closeQoder).toHaveBeenCalledWith(children[0]);
  expect(catalogStrategies(children[0])).toEqual(strategies);
});

test.each([
  { name: "missing entry", models: [] },
  { name: "missing native name", models: [{ value: "qfmodel", displayName: "Qwen3.8-Flash" }] },
])("a cache $name can be confirmed by one live read", async ({ models }) => {
  const children = catalogProcesses(models, "Qwen3.8-Flash", { liveModels: catalog });
  await openListedModel("qfmodel", "Qwen3.8-Flash", children);
  expect(catalogStrategies(children[0])).toEqual(["cache", "live"]);
});

test.each(["cache", "live"] as const)("a failed %s catalog read refuses opening without leaking native details", async (strategy) => {
  const children = catalogProcesses([], "Qwen3.8-Flash", { failure: { kind: "refused", strategy } });
  await expect(qoderSession(installation, { cwd: "/work", model: "qfmodel" })).rejects.toMatchObject({ message: `Qoder could not read ${strategy} model catalog to confirm "qfmodel": Error: Qoder refused get_models` });
  expect(launch.closeQoder).toHaveBeenCalledWith(children[0]);
  expect(catalogStrategies(children[0])).toEqual(strategy === "cache" ? ["cache"] : ["cache", "live"]);
});

test.each(["cache", "live"] as const)("a silent %s catalog read keeps the normal control deadline and cleans up", async (strategy) => {
  vi.useFakeTimers();
  const children = catalogProcesses([], "Qwen3.8-Flash", { failure: { kind: "silent", strategy } });
  const rejected = expect(qoderSession(installation, { cwd: "/work", model: "qfmodel" })).rejects.toThrow("get_models within 30000 ms");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(launch.closeQoder).toHaveBeenCalledWith(children[0]);
  expect(catalogStrategies(children[0])).toEqual(strategy === "cache" ? ["cache"] : ["cache", "live"]);
});


test("a model confirmation failure is not mislabeled as effort when both were requested", async () => {
  const children = catalogProcesses([], "wrong-model");
  await expect(qoderSession(installation, { cwd: "/work", model: "qfmodel", effort: "high" })).rejects.toMatchObject({
    message: 'Qoder model catalog did not contain requested selector "qfmodel"',
  });
  expect(launch.closeQoder).toHaveBeenCalledWith(children[0]);
});

test("a failed effort settings query retains the effort context and closes the process", async () => {
  vi.useFakeTimers();
  const child = slowControlProcess(0, null);
  const rejected = expect(qoderSession(installation, { cwd: "/work", effort: "high" })).rejects.toThrow('Qoder could not confirm effort "high":');
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  expect(launch.closeQoder).toHaveBeenCalledWith(child);
});

test("native startup refusal retains the requested effort without blaming the effort", async () => {
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line));
    process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: frame?.request_id, error: "secret-token" } })}\n`);
  });
  launch.launchQoder.mockResolvedValue(child);
  launch.closeQoder.mockImplementation(async () => { child.end(0); await child.exited; });
  await expect(qoderSession(installation, { cwd: "/work", effort: "oar-no-such-effort" })).rejects.toThrow('Qoder startup failed (requested effort "oar-no-such-effort"): Error: Qoder refused initialize');
  expect(launch.closeQoder).toHaveBeenCalledWith(child);
});
