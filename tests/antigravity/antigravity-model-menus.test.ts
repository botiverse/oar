import { expect, test, vi } from "vitest";
import { RequestError } from "../../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { readAntigravityModelMenus } from "../../packages/oar/src/runtimes/antigravity/model-menus.js";
import { projectAntigravityModels } from "../../packages/oar/src/runtimes/antigravity/list-models.js";

const ids = ["flash", "hydrogen", "sonnet"];
function response(model: string, menu: string[] | null = ["low", "medium", "high"], current = "medium") {
  return { configOptions: [
    { id: "model", currentValue: model, options: ids.map(value => ({ value })) },
    ...(menu === null ? [] : [{ id: "thinking", category: "thought_level", currentValue: current, options: menu.map(value => ({ value })) }]),
  ] };
}
const opened = { sessionId: "session", ...response("flash", undefined, "high"), models: { availableModels: [
  { modelId: "hydrogen-invented" }, { modelId: "sonnet-invented" },
] } };
const fallback = projectAntigravityModels(opened) ?? [];

test("selected menus replace catalog combinations, null means no effort, only the original has a default", async () => {
  // oxlint-disable-next-line max-statements -- Table-driven injection keeps each native failure at its exact phase.
  const set = vi.fn(async (id: string, value: string) => {
    if (id === "thinking") { return response("flash", undefined, value); }
    if (value === "hydrogen") { return response(value, ["low", "high", "xhigh"], "xhigh"); }
    return response(value, value === "sonnet" ? null : undefined);
  });
  expect(await readAntigravityModelMenus(opened, fallback, set)).toEqual([
    { id: "flash", default: true, effortLevels: ["low", "medium", "high"], defaultEffort: "high" },
    { id: "hydrogen", effortLevels: ["low", "high", "xhigh"] },
    { id: "sonnet" },
  ]);
  expect(set.mock.calls).toEqual([["model", "flash"], ["model", "hydrogen"], ["model", "sonnet"], ["model", "flash"], ["thinking", "high"]]);
});

test.each(["refused", "wrong model", "missing readback", "empty menu", "later method missing"])("%s removes stale levels and records a per-model gap", async kind => {
  // oxlint-disable-next-line max-statements -- Table-driven injection keeps each native failure at its exact phase.
  const set = vi.fn(async (id: string, value: string) => {
    if (id === "thinking") { return response("flash", undefined, value); }
    if (value === "hydrogen") {
      if (kind === "refused") { throw new Error("private native error"); }
      if (kind === "later method missing") { throw new RequestError(-32_601, "unsupported"); }
      if (kind === "missing readback") { return {}; }
      return response(kind === "wrong model" ? "flash" : value, kind === "empty menu" ? [] : undefined);
    }
    return response(value, value === "sonnet" ? null : undefined);
  });
  const result = await readAntigravityModelMenus(opened, fallback, set);
  expect(result[1]).toEqual({ id: "hydrogen", effortUnavailableReason: "Native model selection did not return a confirmed effort menu." });
  expect(result[2]).toEqual({ id: "sonnet" });
  expect(set.mock.calls.slice(-2)).toEqual([["model", "flash"], ["thinking", "high"]]);
});

test("a refused first switch clears the original default and still restores after later switches", async () => {
  let calls = 0;
  // oxlint-disable-next-line max-statements -- Table-driven injection keeps each native failure at its exact phase.
  const set = vi.fn(async (id: string, value: string) => {
    calls += 1;
    if (calls === 1) { throw new Error("selection may have changed before failure"); }
    return response(id === "thinking" ? "flash" : value, undefined, id === "thinking" ? value : "low");
  });
  const result = await readAntigravityModelMenus(opened, fallback, set);
  expect(result[0]?.effortUnavailableReason).toBeTypeOf("string");
  expect(result[0]?.defaultEffort).toBeUndefined();
  expect(result[0]?.effortLevels).toBeUndefined();
  expect(set.mock.calls.slice(-2)).toEqual([["model", "flash"], ["thinking", "high"]]);
});

test("method not found on the first selection uses the untouched catalog", async () => {
  const set = vi.fn(async () => { throw new RequestError(-32_601, "unsupported"); });
  expect(await readAntigravityModelMenus(opened, fallback, set)).toBe(fallback);
  expect(set).toHaveBeenCalledOnce();
});

test.each([
  { ...opened, sessionId: undefined },
  { ...opened, ...response("missing") },
  { ...opened, ...response("flash", undefined, "invalid") },
  { ...opened, configOptions: [opened.configOptions[0], { category: "thought_level", currentValue: "high", options: [{ value: "high" }] }] },
])("an initial selection that cannot be restored is never mutated", async initial => {
  const set = vi.fn();
  expect(await readAntigravityModelMenus(initial, fallback, set)).toBe(fallback);
  expect(set).not.toHaveBeenCalled();
});

test.each(["model error", "wrong model", "effort absent", "effort error", "wrong effort", "effort changes model"])("restoration fails closed: %s", async failure => {
  let calls = 0;
  // oxlint-disable-next-line max-statements -- Table-driven injection keeps each native failure at its exact phase.
  const set = vi.fn(async (id: string, value: string) => {
    calls += 1;
    if (calls === 4) {
      if (failure === "model error") { throw new RequestError(-32_000, "Authentication required"); }
      if (failure === "wrong model") { return response("hydrogen"); }
      if (failure === "effort absent") { return response("flash", null); }
    }
    if (id === "thinking") {
      if (failure === "effort error") { throw new Error("failed"); }
      return response(failure === "effort changes model" ? "hydrogen" : "flash", undefined, failure === "wrong effort" ? "low" : value);
    }
    return response(value);
  });
  await expect(readAntigravityModelMenus(opened, fallback, set)).rejects.toThrow("could not confirm restoration");
});

test("an original model without effort is restored without inventing a value", async () => {
  const initial = { sessionId: "session", ...response("sonnet", null) };
  const set = vi.fn(async (_id: string, value: string) => response(value, value === "sonnet" ? null : undefined));
  const result = await readAntigravityModelMenus(initial, projectAntigravityModels(initial) ?? [], set);
  expect(result.find(entry => entry.id === "sonnet")).toEqual({ id: "sonnet", default: true });
  expect(result.every(entry => entry.defaultEffort === undefined)).toBe(true);
  expect(set.mock.calls.at(-1)).toEqual(["model", "sonnet"]);
  expect(set).toHaveBeenCalledTimes(4);
});
