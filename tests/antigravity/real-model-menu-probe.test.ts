/* oxlint-disable max-statements, max-params -- One fake native lifecycle, with the real process factory signature. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { probeRealMenus } from "../../experiments/antigravity-model-menus/probe.js";
import { compareSnapshots, snapshot } from "../../experiments/antigravity-model-menus/config-diff.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const acp = vi.hoisted(() => ({ request: vi.fn<(method: string, params: JsonRecord) => Promise<JsonRecord>>(), kill: vi.fn() }));
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable: async () => ({ ok: true, stdout: "1.5.10\n" }) }));
vi.mock("../../packages/oar/src/shared/acp/process.js", async importOriginal => ({
  ...await importOriginal<object>(),
  startAcpProcess: (_command: string, _args: readonly string[], _client: unknown, options: { outgoing: (message: unknown) => void }) => ({
    spawned: Promise.resolve(), exited: Promise.resolve(0), closed: false, kill: acp.kill,
    connection: { agent: { request: async (method: string, params: JsonRecord) => {
      options.outgoing({ jsonrpc: "2.0", id: 1, method, params });
      return acp.request(method, params);
    } } },
  }),
}));
afterEach(() => { vi.clearAllMocks(); });

const options = (model: string, effort = "low"): JsonRecord => ({ configOptions: [
  { id: "model", currentValue: model, options: [{ value: "pro" }, { value: "flash" }] },
  { id: "thought_level", category: "thought_level", currentValue: effort,
    options: (model === "pro" ? ["low", "high"] : ["low", "medium", "high"]).map(value => ({ value })) },
] });

test.each(["none", "switch", "restoration"])("probe restores native selection or reports failure, without account output: %s", async failure => {
  const home = await mkdtemp(path.join(tmpdir(), "oar-menu-probe-"));
  const state = path.join(home, ".gemini/antigravity-cli/settings.json");
  await mkdir(path.dirname(state), { recursive: true });
  const original = { model: "pro", effort: "high", account: { token: "PRIVATE_TOKEN", email: "person@example.invalid" } };
  await writeFile(state, JSON.stringify(original));
  let model = "pro";
  let effort = "high";
  acp.request.mockImplementation(async (method, params) => {
    if (method === "initialize") { return { agentCapabilities: { sessionCapabilities: { close: {} } } }; }
    if (method === "session/new") { return { sessionId: "PRIVATE_SESSION_ID", ...options(model, effort), models: { availableModels: [{ modelId: "pro" }, { modelId: "flash" }] } }; }
    if (method === "session/close") { return {}; }
    if (method !== "session/set_config_option") { throw new Error("Unexpected method"); }
    if (params.configId === "model") {
      model = String(params.value); effort = "low";
    } else { effort = String(params.value); }
    await writeFile(state, JSON.stringify({ ...original, model, effort }));
    if (failure === "switch" && model === "flash") { throw new Error("PRIVATE_NATIVE_ERROR"); }
    if (failure === "restoration" && params.configId === "thought_level") { return options(model, "low"); }
    return options(model, effort);
  });
  try {
    const result = await probeRealMenus("agy", home, { HOME: home, USERPROFILE: home });
    expect(result.availableModelIds).toEqual(["pro", "flash"]);
    expect(result.methods).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/close"]);
    expect(result.restoration).toEqual(failure === "restoration" ? { confirmed: false } : { model: true, effort: true });
    expect(result.promptRequests).toBe(0);
    expect(JSON.parse(await readFile(state, "utf8"))).toEqual(original);
    const rendered = JSON.stringify(result);
    for (const secret of ["PRIVATE_TOKEN", "person@example.invalid", "PRIVATE_SESSION_ID", "PRIVATE_NATIVE_ERROR", home]) { expect(rendered).not.toContain(secret); }
    if (failure === "switch") { expect(result.failure).toEqual({ phase: "switch/1", code: null }); }
    else {
      expect(result.failure).toBeNull();
      expect(result.switches).toMatchObject([
        { modelId: "pro", thoughtLevel: { options: ["low", "high"], currentValue: "low" } },
        { modelId: "flash", thoughtLevel: { options: ["low", "medium", "high"], currentValue: "low" } },
      ]);
    }
    expect(acp.kill).toHaveBeenCalledOnce();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("parsed diff ignores key order but exposes changed menu values and hides account fields and keys", () => {
  const value = { model: "pro", account: { "person@example.invalid": { token: "PRIVATE_BEFORE" } } };
  const changed = { model: "flash", account: { "person@example.invalid": { token: "PRIVATE_AFTER" } } };
  const before = [{ file: "settings", state: "parsed", value }] as const;
  expect(compareSnapshots(before, [{ ...before[0], value: { account: value.account, model: "pro" } }], new Set())).toMatchObject([{ equal: true, changes: [] }]);
  const diff = compareSnapshots(before, [{ ...before[0], value: changed }], new Set(["pro", "flash"]));
  expect(diff).toMatchObject([{ equal: false, changes: [
    { path: ["[redacted-field]", "[redacted-field]", "[redacted-field]"], before: { value: "[redacted]" }, after: { value: "[redacted]" } },
    { path: ["model"], before: { value: "pro" }, after: { value: "flash" } },
  ] }]);
  expect(JSON.stringify(diff)).not.toMatch(/PRIVATE|person@|token/u);
});

test("unknown initial effort stops before changing native selection", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "oar-menu-unknown-"));
  acp.request.mockImplementation(async method => method === "initialize" ? {} : {
    sessionId: "private", configOptions: [
      { id: "model", currentValue: "pro", options: [{ value: "pro" }] },
      { id: "thought_level", category: "thought_level", options: [{ value: "low" }] },
    ],
  });
  try {
    const result = await probeRealMenus("agy", home, { HOME: home, USERPROFILE: home });
    expect(result.methods).toEqual(["initialize", "session/new"]);
    expect(result.failure).toEqual({ phase: "session/new", code: null });
    expect(result.restoration).toBeNull();
    expect(acp.kill).toHaveBeenCalledOnce();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("invalid or unreadable config is unknown, not an unchanged parsed file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-menu-config-"));
  try {
    const file = path.join(root, "settings.json");
    await writeFile(file, "PRIVATE_NOT_JSON");
    const captured = await snapshot([{ label: "settings", path: file }, { label: "missing", path: path.join(root, "missing") }]);
    expect(captured).toEqual([{ file: "settings", state: "invalid_json" }, { file: "missing", state: "missing" }]);
    const compared = compareSnapshots(captured, captured, new Set());
    expect(asRecord(compared[0])?.equal).toBeNull();
    expect(asRecord(compared[1])?.equal).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
