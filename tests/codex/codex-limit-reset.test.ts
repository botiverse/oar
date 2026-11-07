import { afterEach, expect, test, vi } from "vitest";
import { projectCodexUsage } from "../../packages/oar/src/runtimes/codex/account-usage.js";
import type { AppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { codexRedeemLimitReset } from "../../packages/oar/src/runtimes/codex/limit-reset.js";
import { projectLimitResetOutcome, projectLimitResets } from "../../packages/oar/src/runtimes/codex/reset-credits.js";
import { codexRuntime } from "../../packages/oar/src/runtimes/codex/index.js";

/*
 * Codex reset credits: `rateLimitResetCredits` on `account/rateLimits/read`
 * and `account/rateLimitResetCredit/consume`, shapes from the codex 0.163.0
 * app-server protocol (`codex app-server generate-ts`). No run has spent a
 * real credit.
 */

const startAppServerClient = vi.hoisted(() => vi.fn<(command: string) => AppServerClient>());
vi.mock("../../packages/oar/src/runtimes/codex/app-server-client.js", () => ({ startAppServerClient }));
afterEach(() => { startAppServerClient.mockReset(); });

const installation = { kind: "available", via: "executable", command: "codex", version: "0.163.0" } as const;

function fakeAppServer(answer: (method: string, params: unknown) => Record<string, unknown>): { readonly calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  startAppServerClient.mockImplementation(() => ({
    spawned: Promise.resolve(),
    exited: Promise.resolve(0),
    rootPid: () => undefined,
    async observeCancellation() { return { commit() {}, complete() {} }; },
    async request(method, params) {
      calls.push([method, params]);
      if (method === "initialize") { return {}; }
      if (method === "account/read") { return { account: { type: "chatgpt", email: "person@example.com" }, requiresOpenaiAuth: true }; }
      return answer(method, params);
    },
    notify() {},
    respond() {},
    handle() {},
    mark(placed) { placed(); },
    onExit() {},
    kill() {},
    resources: async () => null,
  }));
  return { calls };
}

const windowOnly = { rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_794_000_000 }, rateLimitReachedType: "rate_limit_reached" } };

test("the usage snapshot carries codex's reset credits", () => {
  const usage = projectCodexUsage({
    ...windowOnly,
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { id: "credit-1", resetType: "codexRateLimits", status: "available", grantedAt: 1_793_000_000, expiresAt: 1_795_000_000, title: "Limit reset", description: null },
        { id: "credit-2", resetType: "codexRateLimits", status: "settling", grantedAt: 1_793_000_000, expiresAt: null, title: null, description: null },
        { id: "credit-3", resetType: "unknown", status: "available", grantedAt: 1_793_000_000, expiresAt: null, title: null, description: null },
      ],
    },
  });
  expect(usage.kind === "available" ? usage.limitResets : null).toEqual({
    available: 2,
    resets: [
      { id: "credit-1", status: "available", grantedAt: "2026-10-26T07:33:20.000Z", expiresAt: "2026-11-18T11:06:40.000Z", title: "Limit reset" },
      { id: "credit-2", status: "unknown", grantedAt: "2026-10-26T07:33:20.000Z" },
    ],
  });
});

test("only the count, no credits, and no summary stay distinct", () => {
  expect(projectLimitResets({ availableCount: 1, credits: null })).toEqual({ available: 1 });
  expect(projectLimitResets({ availableCount: 0, credits: [] })).toEqual({ available: 0, resets: [] });
  expect(projectLimitResets(null)).toBeUndefined();
  expect(projectLimitResets({ availableCount: -1, credits: null })).toBeUndefined();
  const usage = projectCodexUsage({ ...windowOnly, rateLimitResetCredits: null });
  expect(usage.kind === "available" && "limitResets" in usage).toBe(false);
});

test("each codex outcome maps to its own result, and an unknown one rejects", () => {
  expect(projectLimitResetOutcome({ outcome: "reset" })).toEqual({ kind: "reset" });
  expect(projectLimitResetOutcome({ outcome: "nothingToReset" })).toEqual({ kind: "nothing_to_reset" });
  expect(projectLimitResetOutcome({ outcome: "noCredit" })).toEqual({ kind: "no_reset" });
  expect(projectLimitResetOutcome({ outcome: "alreadyRedeemed" })).toEqual({ kind: "already_redeemed" });
  expect(() => projectLimitResetOutcome({ outcome: "toString" })).toThrow("no known limit reset outcome");
  expect(() => projectLimitResetOutcome({})).toThrow("no known limit reset outcome");
});

test("the redeemer sends the caller's key and chosen reset to codex", async () => {
  const server = fakeAppServer(() => ({ outcome: "reset" }));
  await expect(codexRedeemLimitReset(installation, { idempotencyKey: "attempt-1", resetId: "credit-1" })).resolves.toEqual({ kind: "reset" });
  expect(server.calls.at(-1)).toEqual(["account/rateLimitResetCredit/consume", { idempotencyKey: "attempt-1", creditId: "credit-1" }]);

  await codexRedeemLimitReset(installation, { idempotencyKey: "attempt-2" });
  expect(server.calls.at(-1)).toEqual(["account/rateLimitResetCredit/consume", { idempotencyKey: "attempt-2" }]);
});

test("codex's refusals become typed results", async () => {
  fakeAppServer(() => { throw new Error("chatgpt authentication required for rate limit reset credits"); });
  await expect(codexRedeemLimitReset(installation, { idempotencyKey: "a" })).resolves.toEqual({ kind: "unsupported", reason: "unsupported_auth_mode" });
  fakeAppServer(() => { throw new Error("codex account authentication required for rate limit reset credits"); });
  await expect(codexRedeemLimitReset(installation, { idempotencyKey: "a" })).resolves.toEqual({ kind: "reauth_required", reason: "not_authenticated" });
  fakeAppServer(() => { throw new Error("Method not found"); });
  await expect(codexRedeemLimitReset(installation, { idempotencyKey: "a" })).resolves.toEqual({ kind: "unsupported", reason: "endpoint_unavailable" });
});

test("a failed call rejects and tells the caller to retry with the same key", async () => {
  fakeAppServer(() => { throw new Error("rate limit reset consume timed out"); });
  await expect(codexRedeemLimitReset(installation, { idempotencyKey: "a" })).rejects.toThrow("retry with the same idempotencyKey");
});

test("an empty key or reset id is refused before codex starts", async () => {
  await expect(codexRedeemLimitReset(installation, { idempotencyKey: "" })).rejects.toThrow("idempotencyKey must not be empty");
  await expect(codexRedeemLimitReset(installation, { idempotencyKey: "a", resetId: "" })).rejects.toThrow("resetId must not be empty");
  expect(startAppServerClient).not.toHaveBeenCalled();
});

test("codex is the runtime with a redeemer", () => {
  expect(codexRuntime.redeemLimitReset).toBe(codexRedeemLimitReset);
});
