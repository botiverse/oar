/** Linux, no account: pnpm tsx experiments/claude-reset-remote-text/probe.ts /absolute/claude */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeLimitResetDriver } from "../../packages/oar/src/runtimes/claude/limit-reset/driver.js";
import { openScriptTerminal } from "../../packages/oar/src/shared/executable/script-terminal.js";
import { startBackend } from "./backend.js";

const [command] = process.argv.slice(2);
assert.ok(command !== undefined && path.isAbsolute(command), "pass an absolute Claude executable");
assert.equal(process.platform, "linux");
const version = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();

async function run(altered: boolean, operation: "read" | "redeem"): Promise<void> {
  assert.ok(command !== undefined);
  const home = mkdtempSync(path.join(tmpdir(), "oar-claude-remote-text-"));
  const cert = path.join(home, "cert.pem");
  const key = path.join(home, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.anthropic.com",
    "-addext", "subjectAltName=DNS:api.anthropic.com,DNS:claude.ai,DNS:statsig.anthropic.com,DNS:console.anthropic.com,DNS:platform.claude.com,DNS:claude.com,DNS:api.claude.com",
    "-keyout", key, "-out", cert], { stdio: "ignore" });
  const backend = await startBackend(readFileSync(key), readFileSync(cert), altered);
  try {
    mkdirSync(path.join(home, ".claude"));
    const project = path.join(home, "empty");
    mkdirSync(project);
    // No cached feature payload: changed labels must arrive from the local backend.
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true,
      lastOnboardingVersion: version.split(" ")[0], theme: "dark", oauthAccount: {
        accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "probe@example.invalid",
        organizationUuid: "00000000-0000-4000-8000-000000000002", displayName: "Synthetic probe",
      } }));
    writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: "synthetic-not-a-secret", refreshToken: "synthetic-refresh-not-a-secret", expiresAt: Date.now() + 3_600_000,
      scopes: ["user:profile", "user:inference"], subscriptionType: "pro", rateLimitTier: "default_claude_pro",
    } }));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", TERM: "xterm-256color",
      HTTPS_PROXY: backend.url, HTTP_PROXY: backend.url, ALL_PROXY: backend.url, NODE_EXTRA_CA_CERTS: cert,
      DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1",
    };
    const writes: string[] = [];
    const dialogs: string[] = [];
    const driver = createClaudeLimitResetDriver({
      // Host usage and preflight consent gates are separate from the native flag query.
      // oxlint-disable-next-line typescript/promise-function-async -- A fixed synthetic usage answer, independent of the native UI's usage request.
      fiveHourLimit: () => Promise.resolve("not_at_limit"),
      // oxlint-disable-next-line typescript/promise-function-async -- This host gate permits probing; the CLI still fetches its own remote flags.
      cachedFlags: () => Promise.resolve({ limitResets: true }),
      workDir: async () => {
        await access(project);
        return { path: project, remove: async (): Promise<void> => { await rm(project, { recursive: true, force: true }); } };
      },
      onScreen: (step, screen) => {
        if (step.startsWith("command")) {
          const begin = screen.indexOf(altered ? "REMOTE CHANGED:" : "Use a weekly reset?");
          const end = screen.indexOf("Enter to confirm · Esc to cancel", begin);
          if (begin !== -1 && end > begin) { dialogs.push(screen.slice(begin, end).trim()); }
        }
      },
      openTerminal: (input) => {
        const terminal = openScriptTerminal(input);
        assert.ok(terminal);
        return { ...terminal, write(data): void { writes.push(data); terminal.write(data); } };
      },
    });
    const started = Date.now();
    const report = operation === "read"
      ? await driver.read({ command, env, atFiveHourLimit: false, timeoutMs: 75_000 })
      : await driver.redeem({ command, env, kind: "weekly", idempotencyKey: "synthetic-attempt", timeoutMs: 75_000 });
    const elapsedMs = Date.now() - started;
    assert.ok(backend.routes.some((route) => route.startsWith("POST /api/eval")), "native remote flags were fetched");
    assert.ok(backend.routes.some((route) => route === "GET /api/oauth/usage"), "native grant status was fetched");
    const claimRequests = backend.routes.filter((route) => route.includes("reset_rate_limits")).length;
    assert.equal(claimRequests, 0, "no native redemption request");
    assert.ok(dialogs.length > 0, "native confirmation was captured");
    if (altered) {
      assert.ok(dialogs[0]?.includes("REMOTE CHANGED: spend weekly reset?") === true && dialogs[0].includes("REMOTE CHANGED: spend it"));
      assert.deepEqual(writes, ["\u001B[B", "\r", "/limit-reset weekly", "\r", "\u001B"], "only Esc after opening the changed dialog");
      assert.ok(elapsedMs < 20_000, "must not consume the 75 s deadline");
      if (operation === "redeem") { assert.deepEqual(report.result, { kind: "unknown" }); }
      else {
        assert.equal(report.result.kind, "inspected");
        assert.equal(report.result.resets.find((row) => row.id === "weekly")?.state, "unknown");
      }
    } else {
      assert.equal(report.result.kind, "inspected");
      const weekly = report.result.resets.find((row) => row.id === "weekly");
      assert.equal(weekly?.state, "available");
      assert.equal(weekly.resetsLeft, 2);
      assert.equal(typeof weekly.expiresText, "string");
    }
    console.log(JSON.stringify({ version, altered, operation, elapsedMs, report, dialogs,
      keys: writes.map((value) => ({ "\r": "Enter", "\u001B[B": "Down", "\u001B": "Esc" })[value] ?? value),
      remoteFlagsFetched: true, nativeUsageFetched: true, claimRequests,
      modelRequests: backend.routes.filter((route) => route === "POST /v1/messages").length }));
  } finally {
    await backend.close();
    rmSync(home, { recursive: true, force: true });
  }
}

await run(false, "read");
await run(true, "read");
await run(true, "redeem");
