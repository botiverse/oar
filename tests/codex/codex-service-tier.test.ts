import { afterEach, expect, test, vi } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { codexListModels } from "../../packages/oar/src/runtimes/codex/list-models.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex", version: "0.161.0" } as const;
afterEach(() => { spawnLineProcess.mockReset(); vi.useRealTimers(); });

function scripted(reply: Record<string, unknown>, pages: readonly Record<string, unknown>[] = [], openError?: string) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let page = 0;
  const answer = (method: string): Record<string, unknown> => {
    if (method === "initialize") { return { result: {} }; }
    if (method === "model/list") { return { result: pages[page++] }; }
    if (openError !== undefined) { return { error: { code: -32_602, message: openError } }; }
    return { result: { thread: { id: "tier-thread" }, model: "gpt-5.5", ...reply } };
  };
  const child = fakeLineProcess((line, process) => {
    const message = asRecord(JSON.parse(line));
    if (typeof message?.id !== "number" || typeof message.method !== "string") { return; }
    requests.push({ method: message.method, params: asRecord(message.params) ?? {} });
    process.emit(`${JSON.stringify({ id: message.id, ...answer(message.method) })}\n`);
  });
  spawnLineProcess.mockReturnValue(child);
  return { child, requests };
}

test.each([undefined, "tier-thread"])("tier is applied to open (resume=%s), read back and never set per-turn", async (resume) => {
  const { requests } = scripted({ serviceTier: "priority" });
  const session = await codexSession(installation, { cwd: "/work", serviceTier: "priority", ...(resume === undefined ? {} : { resume }) });
  expect(requests.at(-1)).toMatchObject({ method: resume === undefined ? "thread/start" : "thread/resume", params: { serviceTier: "priority" } });
  expect(session.serviceTier().value).toBe("priority");
  await session.prompt("hello");
  expect(requests.find((request) => request.method === "turn/start")?.params).not.toHaveProperty("serviceTier");
  await session.dispose();
});

test.each([undefined, "tier-thread"])("substitution, alias, null and absent reports fail before open (resume=%s)", async (resume) => {
  for (const [requested, reply, reported] of [
    ["priority", { serviceTier: "flex" }, "flex"],
    ["fast", { serviceTier: "priority" }, "priority"],
    ["priority", { serviceTier: null }, "default"],
    ["priority", {}, "unreported"],
  ] as const) {
    const { child } = scripted(reply);
    // oxlint-disable-next-line no-await-in-loop -- Each native report is independently refused.
    await expect(codexSession(installation, { cwd: "/work", serviceTier: requested, ...(resume === undefined ? {} : { resume }) })).rejects.toThrow(`reports serviceTier ${reported} although ${requested} was requested`);
    expect(child.killed()).toBe(true);
  }
});

test.each([undefined, "tier-thread"])("native open errors retain the requested tier and reclaim the child (resume=%s)", async (resume) => {
  const { child } = scripted({}, [], "selection unavailable");
  await expect(codexSession(installation, { cwd: "/work", serviceTier: "priority", ...(resume === undefined ? {} : { resume }) })).rejects.toThrow("serviceTier priority could not be confirmed (actual unreported): selection unavailable");
  expect(child.killed()).toBe(true);
});

test("omitting tier preserves the native selection and null means no special tier", async () => {
  const { requests } = scripted({ serviceTier: null });
  const session = await codexSession(installation, { cwd: "/work", resume: "tier-thread" });
  expect(requests.at(-1)?.params).not.toHaveProperty("serviceTier");
  expect(session.serviceTier().value).toBe("default");
  await session.dispose();
});

test("settings notifications preserve a change and explicit removal", () => {
  for (const [native, reported] of [["flex", "flex"], [null, "default"]] as const) {
    const params = { threadId: "tier-thread", threadSettings: { serviceTier: native } };
    const { commands } = foldCodexNotification(initialCodexProjection("tier-thread"), "thread/settings/updated", params);
    expect(commands).toContainEqual(expect.objectContaining({ kind: "frame", body: { type: "thread/settings/updated", native: params, events: [{ kind: "service_tier", serviceTier: reported }] } }));
  }
});

test("model listing uses app-server pagination and stops its process", async () => {
  const { requests, child } = scripted({}, [
    { data: [{ model: "a", serviceTiers: [{ id: "priority" }] }], nextCursor: "next" },
    { data: [{ model: "b", serviceTiers: [{ id: "flex" }], defaultServiceTier: "flex" }], nextCursor: null },
  ]);
  expect(await codexListModels(installation)).toEqual({ kind: "ok", models: [
    { id: "a", serviceTiers: ["priority"] }, { id: "b", serviceTiers: ["flex"], defaultServiceTier: "flex" },
  ] });
  expect(requests.filter((request) => request.method === "model/list").map((request) => request.params)).toEqual([{}, { cursor: "next" }]);
  expect(child.killed()).toBe(true);
});

test("model listing rejects malformed or looping pagination and reclaims the process", async () => {
  for (const pages of [[{}], [{ data: [], nextCursor: "same" }, { data: [], nextCursor: "same" }]]) {
    const { child } = scripted({}, pages);
    // oxlint-disable-next-line no-await-in-loop -- Both failure modes must reclaim their own child.
    await expect(codexListModels(installation)).rejects.toThrow("Failed to list Codex models");
    expect(child.killed()).toBe(true);
  }
});

test("model listing has one deadline including initialization", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const listing = codexListModels(installation, { timeoutMs: 10 });
  const rejected = expect(listing).rejects.toThrow("timed out after 10 ms");
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  expect(child.killed()).toBe(true);
});
