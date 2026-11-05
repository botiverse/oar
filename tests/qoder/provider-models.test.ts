import { afterEach, expect, test, vi } from "vitest";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { projectQoderModels, readQoderModels } from "../../packages/oar/src/runtimes/qoder/list-models.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const launch = vi.hoisted(() => ({ launchQoder: vi.fn(), closeQoder: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/qoder/launch.js", () => launch);
afterEach(() => { vi.clearAllMocks(); });
const row = { value: "qfmodel", modelId: "qfmodel", displayName: "Qwen3.8-Flash" };
const installation = { kind: "available", via: "executable", command: "fixture", version: "1.1.83" } as const;

function native(models: readonly JsonRecord[], reported = row.displayName, options: { readonly version?: string; readonly live?: readonly JsonRecord[] } = {}) {
  const { version = "1.1.83", live = models } = options;
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line));
    const request = asRecord(frame?.request);
    if (request?.subtype === "initialize") { process.emit(`${JSON.stringify({ type: "system", subtype: "init", model: reported })}\n`); }
    const response = request?.subtype === "get_models" ? { models: request.fetchStrategy === "live" ? live : models, access_token: "fixture-private" } : {};
    process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame?.request_id, response } })}\n`);
  });
  launch.launchQoder.mockResolvedValue(Object.assign(child, { qoderVersion: version }));
  launch.closeQoder.mockImplementation(async () => { child.end(0); await child.exited; });
  return child;
}

test.each(["1.1.82", "1.1.83"])("%s confirms the native provider identity and preserves its init name", async (version) => {
  const child = native([row], row.displayName, { version });
  const session = await qoderSession({ ...installation, version }, { cwd: "/work", model: row.value });
  try {
    expect(session.model().value).toBe(row.displayName);
    expect(child.written.map(line => asRecord(asRecord(parseJson(line))?.request))).toContainEqual({ subtype: "get_models", fetchStrategy: "cache" });
    expect(JSON.stringify(session.records())).not.toContain("fixture-private");
    expect(projectQoderModels({ models: [row] }, version)).toEqual([{ id: row.value, resolvedId: row.displayName, displayName: row.displayName }]);
  } finally { await session.dispose(); }
});

test.each([
  { name: "missing modelId", rows: [{ value: row.value, displayName: row.displayName }] },
  { name: "different modelId", rows: [{ ...row, modelId: "other" }] },
  { name: "empty displayName", rows: [{ ...row, displayName: "" }] },
  { name: "duplicate displayName", rows: [row, { ...row, value: "other", modelId: "other" }] },
  { name: "disabled duplicate displayName", rows: [row, { ...row, value: "other", modelId: "other", isEnabled: false }] },
  { name: "duplicate selector", rows: [row, { ...row, displayName: "Other" }] },
  { name: "old field only", rows: [{ value: row.value, modelId: row.value, serverModel: { display_name: row.displayName } }] },
])("provider catalog rejects $name and does not publish an unverified resolvedId", async ({ rows }) => {
  const child = native(rows);
  await expect(qoderSession(installation, { cwd: "/work", model: row.value })).rejects.toThrow("did not provide a resolved name");
  expect(launch.closeQoder).toHaveBeenCalledWith(child);
  expect(projectQoderModels({ models: rows }, installation.version)[0]?.resolvedId).toBeUndefined();
});

test("provider init equal to a selector still cannot bypass an ambiguous catalog", async () => {
  native([{ ...row, displayName: row.value }, { value: "other", modelId: "other", displayName: row.value }], row.value);
  await expect(qoderSession(installation, { cwd: "/work", model: row.value })).rejects.toThrow("did not provide a resolved name");
});

test("provider init must exactly match the selected unique native displayName", async () => {
  native([row], "Qwen 3.8 Flash");
  await expect(qoderSession(installation, { cwd: "/work", model: row.value })).rejects.toThrow("did not confirm model");
});

test("provider catalog without the requested selector cannot confirm init", async () => {
  native([{ ...row, value: "other", modelId: "other" }]);
  await expect(qoderSession(installation, { cwd: "/work", model: row.value })).rejects.toThrow("did not contain requested selector");
});

test("an incomplete provider cache can be confirmed by one unambiguous live catalog", async () => {
  const child = native([], row.displayName, { live: [row] });
  const session = await qoderSession(installation, { cwd: "/work", model: row.value });
  try {
    const strategies = child.written.map(line => asRecord(asRecord(parseJson(line))?.request)).filter(request => request?.subtype === "get_models").map(request => request?.fetchStrategy);
    expect(strategies).toEqual(["cache", "live"]);
    expect(session.model().value).toBe(row.displayName);
  } finally { await session.dispose(); }
});

test("1.1.81 cannot borrow a provider displayName and public unversioned projection stays legacy", async () => {
  native([row], row.displayName, { version: "1.1.81" });
  await expect(qoderSession({ ...installation, version: "1.1.81" }, { cwd: "/work", model: row.value })).rejects.toThrow("did not provide a resolved name");
  expect(projectQoderModels({ models: [row] })).toEqual([{ id: row.value, displayName: row.displayName }]);
  expect(projectQoderModels({ models: [row] }, "1.1.81")).toEqual([{ id: row.value, displayName: row.displayName }]);
});

test("a missing installation version uses the version resolved by launch for confirmation and listing", async () => {
  native([row]);
  const session = await qoderSession({ kind: "available", via: "executable", command: "fixture" }, { cwd: "/work", model: row.value });
  try { expect(session.model().value).toBe(row.displayName); }
  finally { await session.dispose(); }
  native([row]);
  expect(await readQoderModels("fixture", { cwd: "/work" })).toEqual([{ id: row.value, resolvedId: row.displayName, displayName: row.displayName }]);
});
