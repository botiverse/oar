/* oxlint-disable import/max-dependencies -- One real-process regression exercises each affected account entry point. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { AvailableInstallation } from "../packages/oar/src/contracts/installation.js";
import type { AccountUsageReadOptions } from "../packages/oar/src/contracts/account-usage.js";
import { claudeAccountUsage } from "../packages/oar/src/runtimes/claude/account-usage.js";
import { codexAccountUsage } from "../packages/oar/src/runtimes/codex/account-usage.js";
import { codexRedeemLimitReset } from "../packages/oar/src/runtimes/codex/limit-reset.js";
import { grokAccountUsage } from "../packages/oar/src/runtimes/grok/account-usage.js";
import { kimiAccountUsage } from "../packages/oar/src/runtimes/kimi/account-usage.js";
import { claudeAuthStatus } from "../packages/oar/src/runtimes/claude/auth-status.js";
import { codexAuthStatus, readCodexAuthStatus } from "../packages/oar/src/runtimes/codex/login.js";
import { qoderAuthStatus } from "../packages/oar/src/runtimes/qoder/auth-status.js";
import { codebuddyAuthStatus } from "../packages/oar/src/runtimes/codebuddy/auth-status.js";
import { kimiAuthStatus } from "../packages/oar/src/runtimes/kimi/auth-status.js";
import { fakeAgentBinary, gone, withTreeProbe } from "./fixtures/process-tree.js";

const script = fileURLToPath(new URL("fixtures/stalled-account-query.mjs", import.meta.url));
const TIMEOUT = 1500;
const GRACE = 1500;
type Read = (installation: AvailableInstallation, options: AccountUsageReadOptions) => Promise<unknown>;
const cases: readonly { name: string; stage: string; read: Read }[] = [
  { name: "Codex initialize", stage: "initialize", read: codexAccountUsage },
  { name: "Codex account preflight", stage: "account/read", read: codexAccountUsage },
  { name: "Codex usage", stage: "account/rateLimits/read", read: codexAccountUsage },
  { name: "Codex redemption", stage: "account/rateLimitResetCredit/consume", read: async (installation, options) =>
    codexRedeemLimitReset(installation, { ...options, idempotencyKey: "synthetic-deadline" }) },
  { name: "Claude help", stage: "help", read: claudeAccountUsage },
  { name: "Claude usage", stage: "get_usage", read: claudeAccountUsage },
  { name: "Grok billing", stage: "_x.ai/billing", read: grokAccountUsage },
  { name: "Grok optional identity", stage: "_x.ai/auth/info", read: grokAccountUsage },
  { name: "Kimi provider list", stage: "started", read: kimiAccountUsage },
  { name: "Claude status", stage: "started", read: claudeAuthStatus },
  { name: "Codex status", stage: "started", read: codexAuthStatus },
  { name: "Qoder status", stage: "started", read: qoderAuthStatus },
  { name: "CodeBuddy status", stage: "initialize", read: codebuddyAuthStatus },
  { name: "Kimi status", stage: "authenticate", read: kimiAuthStatus },
];
afterEach(() => { vi.unstubAllEnvs(); });

// SIGTERM resistance is POSIX-only. Windows still proves timely rejection and
// eventual tree cleanup through the same public calls and real fixture process.
test.each(cases)("$name settles at its deadline while owned cleanup continues", async ({ name, stage, read }) => {
  vi.stubEnv("OAR_KILL_GRACE_MS", String(GRACE));
  // oxlint-disable-next-line max-statements -- Keep return timing, requests and eventual process liveness in one observation.
  await withTreeProbe({ ignoreSigterm: true }, async (probe) => {
    const command = fakeAgentBinary(probe.dir, [script]);
    const requests = path.join(probe.dir, "requests");
    const installation = { kind: "available", via: "executable", command } as const;
    const started = performance.now();
    // Observe rejection immediately, even while waiting for startup evidence.
    const result = read(installation, { timeoutMs: TIMEOUT, env: {
      ...probe.env, HOME: probe.dir, CODEX_HOME: probe.dir, CODEBUDDY_API_KEY: null,
      OAR_QUERY_STAGE: stage, OAR_QUERY_REQUESTS: requests,
    } }).then((value) => ({ value, error: null, elapsed: performance.now() - started }), (error: unknown) => ({ value: null, error, elapsed: performance.now() - started }));
    const tree = await probe.tree();
    const outcome = await result;
    if (name.endsWith("status")) {
      expect(outcome.value).toMatchObject({ kind: "unknown" });
      expect(outcome.value).toHaveProperty("detail", expect.stringContaining("timed out"));
      expect(outcome.error).toBeNull();
    } else { expect(outcome.error).toBeInstanceOf(Error); }
    expect(outcome.elapsed).toBeGreaterThanOrEqual(TIMEOUT - 50);
    expect(outcome.elapsed).toBeLessThan(TIMEOUT + 1000);
    if (name === "Codex redemption") {
      expect(outcome.error).toHaveProperty("message", expect.stringMatching(/whether it was spent is unknown.*same idempotencyKey/u));
    }
    if (process.platform !== "win32") { expect(await gone(tree.agent, 0)).toBe(false); }
    expect(await gone(tree.agent)).toBe(true);
    expect(await gone(tree.grandchild)).toBe(true);
    const sent = readFileSync(requests, "utf8").trim().split("\n");
    expect(sent).toContain(stage);
    // ACP may send its standard cancellation notification while stopping.
    expect(sent.findLast((method) => method !== "$/cancel_request")).toBe(stage);
  });
});

test.skipIf(process.platform === "win32")("login/logout's internal status reader still joins cleanup", async () => {
  vi.stubEnv("OAR_KILL_GRACE_MS", String(GRACE));
  await withTreeProbe({ ignoreSigterm: true }, async (probe) => {
    const command = fakeAgentBinary(probe.dir, [script]);
    const started = performance.now();
    const result = readCodexAuthStatus({ kind: "available", via: "executable", command }, {
      timeoutMs: TIMEOUT, env: { ...probe.env, OAR_QUERY_REQUESTS: path.join(probe.dir, "requests") },
    });
    const tree = await probe.tree();
    expect(await result).toMatchObject({ kind: "unknown" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(TIMEOUT + GRACE - 50);
    expect(await gone(tree.agent, 0)).toBe(true);
    expect(await gone(tree.grandchild)).toBe(true);
  });
});
