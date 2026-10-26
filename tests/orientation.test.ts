import { readdir } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { defineRuntime, RuntimeRegistry, orient, UnsupportedOptionError, type AuthStatusReader, type Runtime, type InstallationSnapshot, type ListModelsResult, type InventoryResult, type SkillEntry } from "../packages/oar/src/index.js";

afterEach(() => { vi.useRealTimers(); });
function runtime(overrides: Partial<Runtime> = {}): Runtime {
  return defineRuntime({
    id: "probe", session: async () => { throw new Error("orientation must not open a session"); },
    installation: async () => ({ kind: "available", via: "bundled" }),
    authStatus: Object.assign(async () => ({ kind: "logged_in" as const, source: "fixture" }), { localOnly: true as const }), ...overrides,
  });
}
async function later<T>(milliseconds: number, value: T): Promise<T> {
  const pending = Promise.withResolvers<T>();
  setTimeout(() => { pending.resolve(value); }, milliseconds);
  const result = await pending.promise;
  return result;
}
function catalog(items: readonly SkillEntry[], partial = false): Extract<InventoryResult<SkillEntry>, { kind: "ok" }> {
  return { kind: "ok", items, partial, view: "discovered", observedAt: "2026-10-23T00:00:00.000Z", scope: { kind: "workspace", cwd: "/unused" } };
}

test("local asks only local members and unparsed stored providers", async () => {
  const accountUsage = vi.fn(), listModels = vi.fn(), skills = vi.fn();
  const providers = vi.fn(async () => [{ providerId: "stored", configured: true, method: "oauth" as const, subscription: true }]);
  const report = await orient(new RuntimeRegistry([runtime({ accountUsage, listModels, skills, providers })]));
  expect([accountUsage.mock.calls.length, listModels.mock.calls.length, skills.mock.calls.length]).toEqual([0, 0, 0]);
  expect(providers).toHaveBeenCalledWith({ kind: "available", via: "bundled" }, expect.objectContaining({ resolve: false }));
  expect(report.depth).toBe("local");
  expect(report.runtimes[0]).not.toHaveProperty("models");
  expect(report.runtimes[0]?.providers).toMatchObject({ kind: "ok", value: [{ providerId: "stored", method: "oauth" }] });
});

test("account resolves provider status and models depth lists without invoking a model", async () => {
  const listModels = vi.fn(async (): Promise<ListModelsResult> => ({ kind: "ok", models: [{ id: "native-model" }] })), providers = vi.fn(async () => []);
  const report = await orient(new RuntimeRegistry([runtime({ providers, listModels })]), { depth: "models" });
  expect(providers.mock.calls).toHaveLength(1);
  expect(providers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resolve: true }));
  expect(report.runtimes[0]?.models).toMatchObject({ kind: "ok", value: [{ id: "native-model" }] });
  expect(report.runtimes[0]?.accountUsage).toEqual({ kind: "unsupported" });
});

test("missing installation skips existing capabilities, while absent members stay unsupported", async () => {
  const authStatus = vi.fn();
  const missing = runtime({ id: "missing", installation: async () => ({ kind: "not_found" }), authStatus });
  const bare = defineRuntime({ id: "bare", session: missing.session });
  const report = await orient(new RuntimeRegistry([missing, bare]), { depth: "models" });
  expect(authStatus).not.toHaveBeenCalled();
  expect(report.runtimes.map((entry) => [entry.installation.kind, entry.auth, entry.models])).toMatchInlineSnapshot(`
    [
      [
        "ok",
        {
          "because": "not_installed",
          "kind": "skipped",
        },
        {
          "kind": "unsupported",
        },
      ],
      [
        "unsupported",
        {
          "kind": "unsupported",
        },
        {
          "kind": "unsupported",
        },
      ],
    ]
  `);
});

test("an explicit logged-out status prevents account and model reads", async () => {
  const accountUsage = vi.fn(), listModels = vi.fn();
  const report = await orient(new RuntimeRegistry([runtime({ authStatus: async () => ({ kind: "logged_out", source: "fixture" }), accountUsage, listModels })]), { depth: "models" });
  expect(accountUsage).not.toHaveBeenCalled();
  expect(listModels).not.toHaveBeenCalled();
  expect(report.runtimes[0]?.models).toEqual({ kind: "skipped", because: "logged_out" });
});

test("a thrown secret-bearing error is isolated, sanitized and does not suppress other facts", async () => {
  const bad = runtime({ id: "bad", accountUsage: async () => { throw new Error("credential-secret-sentinel"); }, listModels: async () => ({ kind: "ok", models: [{ id: "visible" }] }) });
  const report = await orient(new RuntimeRegistry([bad, runtime({ id: "good" })]), { depth: "models" });
  expect(report.runtimes[0]?.accountUsage).toMatchObject({ kind: "failed", reason: "The runtime query failed" });
  expect(report.runtimes[0]?.models).toMatchObject({ kind: "ok", value: [{ id: "visible" }] });
  expect(report.runtimes[1]?.auth.kind).toBe("ok");
  expect(JSON.stringify(report)).not.toContain("credential-secret-sentinel");
});

test("the overall deadline returns a partial snapshot without waiting on a stuck installation", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<InstallationSnapshot>();
  const result = orient(new RuntimeRegistry([runtime({ id: "slow", installation: async () => pending.promise }), runtime({ id: "fast" })]), { timeoutMs: 20 });
  await vi.advanceTimersByTimeAsync(20);
  const report = await result;
  expect(report.runtimes.map((entry) => [entry.installation.kind, entry.auth.kind])).toEqual([["timed_out", "timed_out"], ["ok", "ok"]]);
  pending.resolve({ kind: "not_found" });
});

test("a runtime cannot spend a fresh deadline on each sequential stage", async () => {
  vi.useFakeTimers();
  const subject = runtime({ installation: async () => later<InstallationSnapshot>(25_000, { kind: "available", via: "bundled" }), authStatus: async () => later(25_000, { kind: "logged_in" as const, source: "fixture" }) });
  const result = orient(new RuntimeRegistry([subject]), { depth: "account" });
  await vi.advanceTimersByTimeAsync(45_000);
  const report = await result;
  expect(report.runtimes[0]?.auth.kind).toBe("timed_out");
  await vi.runAllTimersAsync();
});

// oxlint-disable-next-line eslint/max-statements -- observe the deadline and later release with one set of held native queries.
test("models are limited to two concurrent native reads and queued work never starts after expiry", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<ListModelsResult>(), started: string[] = [];
  const runtimes = ["a", "b", "c"].map((id) => runtime({ id, listModels: async () => { started.push(id); return pending.promise; } }));
  const result = orient(new RuntimeRegistry(runtimes), { depth: "models", timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(50);
  expect(started).toEqual(["a", "b"]);
  const report = await result;
  expect(report.runtimes.map((entry) => entry.models?.kind)).toEqual(["timed_out", "timed_out", "timed_out"]);
  pending.resolve({ kind: "ok", models: [] });
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual(["a", "b"]);
});

// oxlint-disable-next-line eslint/max-statements -- verify the same queue before abort and after its held native calls settle.
test("abort stops waiting and does not start model queries queued behind native reads", async () => {
  vi.useFakeTimers();
  const abort = new AbortController(), pending = Promise.withResolvers<ListModelsResult>();
  const started = vi.fn(async () => pending.promise);
  const result = orient(new RuntimeRegistry(["a", "b", "c"].map((id) => runtime({ id, listModels: started }))), { depth: "models", signal: abort.signal });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await rejected;
  pending.resolve({ kind: "ok", models: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toHaveBeenCalledTimes(2);
});

test("customization uses an empty directory and excludes explicitly non-user entries", async () => {
  const skills: Runtime["skills"] = async (_installation, options) => {
    expect(await readdir(options?.cwd ?? "")).toEqual([]);
    return catalog([{ name: "personal", source: "user" }, { name: "built-in", source: "builtin" }, { name: "project", source: "project" }]);
  };
  const report = await orient(new RuntimeRegistry([runtime({ skills })]), { include: ["customization"] });
  expect(report.runtimes[0]?.customization).toMatchObject({ kind: "ok", value: { skills: 1 } });
});

test("partial discovery fails customization instead of publishing a plausible count", async () => {
  const report = await orient(new RuntimeRegistry([runtime({ skills: async () => catalog([], true), commands: async () => catalog([{ name: "known", source: "user" }]) })]), { include: ["customization"] });
  expect(report.runtimes[0]?.customization).toMatchObject({ kind: "failed" });
});

test("ambiguous sources and context-only catalogs are omitted, not counted as zero", async () => {
  const report = await orient(new RuntimeRegistry([runtime({ skills: async () => catalog([{ name: "plugin", source: "plugin" }]), commands: async () => ({ ...catalog([{ name: "command", source: "user" }]), view: "context" }) })]), { include: ["customization"] });
  expect(report.runtimes[0]?.customization).toEqual({ kind: "unsupported" });
});

test("runtime selection preserves requested order and rejects unknown ids before any probe", async () => {
  const installation = vi.fn(async (): Promise<InstallationSnapshot> => ({ kind: "not_found" }));
  const registry = new RuntimeRegistry([runtime({ id: "a", installation }), runtime({ id: "b", installation })]);
  await expect(orient(registry, { runtimes: ["missing"] })).rejects.toThrow("unknown runtime");
  expect(installation).not.toHaveBeenCalled();
  const report = await orient(registry, { runtimes: ["b", "a", "b"] });
  expect(report.runtimes.map((entry) => entry.id)).toEqual(["b", "a"]);
});


test("unproven auth readers are skipped locally and called only at account depth", async () => {
  const authStatus = vi.fn(async () => ({ kind: "logged_in" as const, source: "fixture" }));
  const registry = new RuntimeRegistry([runtime({ authStatus })]);
  const local = await orient(registry);
  expect(local.runtimes[0]?.auth).toEqual({ kind: "skipped", because: "depth" });
  expect(authStatus).not.toHaveBeenCalled();
  const account = await orient(registry, { depth: "account" });
  expect(account.runtimes[0]?.auth.kind).toBe("ok");
  expect(authStatus).toHaveBeenCalledOnce();
});

test("a declared local auth reader preserves its native answer", async () => {
  const authStatus: AuthStatusReader = Object.assign(async () => ({ kind: "logged_out" as const, source: "fixture" }), { localOnly: true as const });
  const registry = new RuntimeRegistry([runtime({ authStatus })]);
  const snapshot = await orient(registry);
  expect(snapshot.runtimes[0]?.auth).toMatchObject({ kind: "ok", value: { kind: "logged_out" } });
});

// oxlint-disable-next-line max-statements -- All observation surfaces must receive exactly the host's chosen overlay.
test.each([false, true])("orient uses the declared session env policy for every reader (refused: %s)", async (refused) => {
  const env = { HOME: "scoped", HTTP_PROXY: null };
  const installation = vi.fn(async () => ({ kind: "available", via: "bundled" } as const));
  const authStatus = vi.fn(async () => ({ kind: "logged_in", source: "fixture" } as const));
  const providers = vi.fn(async () => []);
  const accountUsage = vi.fn(async () => ({ kind: "available", rateLimited: false, windows: [] } as const));
  const listModels = vi.fn(async () => ({ kind: "ok", models: [] } as const));
  const inventory = vi.fn(async () => ({ ...catalog([]), items: [] }));
  const fixture = runtime({ refusedSessionOptions: refused ? { env: "fixture uses host environment" } : {}, installation, authStatus, providers, accountUsage, listModels, skills: inventory, commands: inventory, tools: inventory, mcpServers: inventory });
  await orient(new RuntimeRegistry([fixture]), { depth: "models", include: ["customization"], env });
  expect(installation).toHaveBeenCalledWith(refused ? {} : { env });
  for (const read of [authStatus, providers, accountUsage, listModels, inventory]) {
    if (refused) {
      const calls: readonly (readonly unknown[])[] = read.mock.calls;
      for (const call of calls) { expect(call[1]).not.toHaveProperty("env"); }
    }
    else { expect(read).toHaveBeenCalledWith({ kind: "available", via: "bundled" }, expect.objectContaining({ env })); }
  }
  expect(inventory).toHaveBeenCalledTimes(4);
});

const refuse = async (): Promise<never> => { throw new UnsupportedOptionError("env", "sensitive internal detail"); };

test.each(["installation", "authStatus", "providers", "accountUsage", "listModels", "skills"] as const)("an env refusal from %s stays unsupported instead of failed", async (member) => {
  const fixture = runtime({ [member]: refuse });
  const result = await orient(new RuntimeRegistry([fixture]), { depth: "models", include: ["customization"], env: { HOME: "scoped" } });
  const field = { installation: "installation", authStatus: "auth", providers: "providers", accountUsage: "accountUsage", listModels: "models", skills: "customization" } as const;
  expect(result.runtimes[0]?.[field[member]]).toEqual({ kind: "unsupported" });
  expect(JSON.stringify(result)).not.toContain("sensitive");
});
