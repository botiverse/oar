/**
 * Special-resolver install teeth, driven through the PRODUCTION assembly
 * `detectInstallRegistered(createHostInstallTargets(), …)` — never a resolver unit call.
 *
 * Contract (OAR task #6, frozen msg 932b06a6; seam shape ruled by @Huaihuai):
 *   - `CommandResolveDeps` stays resolution-only; the adapter maps it onto the resolvers'
 *     own which/exists. Global `cli.which()` is untouched.
 *   - The raw command runner is injected; `appServerOk` / `version` are still derived by
 *     production `probeCommand`. Tests supply command RESULTS, never eligibility.
 *   - Branch liveness is proven by injected CALL LOGS, not by public row fields, because
 *     the public row may not carry raw paths/commands and both sides of a PATH control can
 *     read `resolution=command`.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { detectInstallRegistered } from "./installDetect.js";
import { createHostInstallTargets } from "./host/runtimeDrivers.js";
import {
  CLAUDE_DESKTOP_CLI_RELATIVE_PATH,
  CLAUDE_DESKTOP_CLI_SYSTEM_PATH,
} from "./host/claudeResolve.js";
import { clearCodexProbeCacheForTests } from "./host/codexResolve.js";

const HOME = "/fake/home";
const CLAUDE_DESKTOP = path.join(HOME, CLAUDE_DESKTOP_CLI_RELATIVE_PATH);
const CODEX_DESKTOP = path.join(HOME, ".codex", "plugins", ".plugin-appserver", "codex");

type Probed = { command: string; args: readonly string[] };

/** Records every resolution/execution the production code actually performs. */
function harness(opts: {
  onPath?: Record<string, string>;
  existing?: readonly string[];
  env?: NodeJS.ProcessEnv;
  appServerOkFor?: (command: string) => boolean;
  version?: string;
}) {
  const whichAsked: string[] = [];
  const existsAsked: string[] = [];
  const probed: Probed[] = [];
  const onPath = opts.onPath ?? {};
  const existing = new Set(opts.existing ?? []);
  const version = opts.version ?? "codex-cli 0.144.6";

  return {
    whichAsked,
    existsAsked,
    probed,
    hooks: {
      commandResolve: {
        platform: "darwin" as NodeJS.Platform,
        env: { HOME, ...opts.env },
        // resolveCommandOnPath's darwin path shells out to `which <cmd>`; throwing is "not on PATH".
        execFileSyncFn: ((_cmd: string, args?: readonly string[]) => {
          const name = String(args?.at(-1) ?? "");
          whichAsked.push(name);
          const hit = onPath[name];
          if (!hit) throw new Error(`not on PATH: ${name}`);
          return `${hit}\n`;
        }) as never,
        existsSyncFn: (p: string) => {
          existsAsked.push(p);
          return existing.has(p);
        },
      },
      runCommand: (command: string, args: readonly string[]) => {
        probed.push({ command, args });
        const isAppServerGate = args[0] === "app-server";
        if (isAppServerGate) {
          const ok = opts.appServerOkFor ? opts.appServerOkFor(command) : true;
          return { ok, stdout: "", stderr: "", code: ok ? 0 : 1 };
        }
        return { ok: true, stdout: `${version}\n`, stderr: "", code: 0 };
      },
    },
  };
}

async function rowFor(runtime: string, hooks: unknown) {
  const rows = await detectInstallRegistered(
    createHostInstallTargets(),
    [runtime],
    hooks as never,
  );
  return rows[0]!;
}

test("① Claude desktop-only: not on PATH, desktop bundle present => available via the real resolver", async () => {
  const h = harness({ onPath: {}, existing: [CLAUDE_DESKTOP], version: "1.2.3" });
  const row = await rowFor("claude", h.hooks);

  assert.equal(row.state, "available", JSON.stringify(row));
  assert.equal(row.evidence.resolution, "command");

  // Liveness: the desktop branch was genuinely reached and asked about the expected candidate.
  assert.ok(
    h.existsAsked.includes(CLAUDE_DESKTOP),
    `desktop candidate never probed; asked=${JSON.stringify(h.existsAsked)}`,
  );
  assert.ok(h.whichAsked.includes("claude"), "PATH was never consulted first");
});

test("① control: same harness but claude IS on PATH => desktop candidate is never probed", async () => {
  const h = harness({ onPath: { claude: "/usr/local/bin/claude" }, existing: [CLAUDE_DESKTOP] });
  const row = await rowFor("claude", h.hooks);

  assert.equal(row.state, "available");
  // The distinguishing observation is the call log, not the row: both cases read resolution=command.
  assert.ok(
    !h.existsAsked.includes(CLAUDE_DESKTOP),
    "PATH hit should short-circuit before the desktop bundle",
  );
  assert.ok(
    !h.existsAsked.includes(CLAUDE_DESKTOP_CLI_SYSTEM_PATH),
    "PATH hit should short-circuit before the system bundle",
  );
});

test("② Codex authoritative CODEX_BIN: override wins over a winnable PATH candidate", async () => {
  clearCodexProbeCacheForTests();
  const OVERRIDE = "/opt/custom/codex";
  const h = harness({
    // A PATH candidate that would win on its own — without it, removing the early return
    // would change nothing and the tooth could not fail.
    onPath: { codex: "/usr/local/bin/codex" },
    existing: [OVERRIDE],
    env: { CODEX_BIN: OVERRIDE },
  });
  const row = await rowFor("codex", h.hooks);

  assert.equal(row.state, "available", JSON.stringify(row));
  const gateProbes = h.probed.filter((p) => p.args[0] === "app-server").map((p) => p.command);
  assert.deepEqual(
    gateProbes,
    [OVERRIDE],
    "the override must be the only app-server-gated candidate; PATH must not be arbitrated",
  );
});

test("② fail-closed: CODEX_BIN set but its app-server probe fails => not available, PATH not used as fallback", async () => {
  clearCodexProbeCacheForTests();
  const OVERRIDE = "/opt/custom/codex";
  const h = harness({
    onPath: { codex: "/usr/local/bin/codex" },
    existing: [OVERRIDE],
    env: { CODEX_BIN: OVERRIDE },
    appServerOkFor: (command) => command !== OVERRIDE,
  });
  const row = await rowFor("codex", h.hooks);

  assert.notEqual(row.state, "available", `override failure must not fall through: ${JSON.stringify(row)}`);
  const gateProbes = h.probed.filter((p) => p.args[0] === "app-server").map((p) => p.command);
  assert.deepEqual(gateProbes, [OVERRIDE], "a rejected override must not hand off to PATH discovery");
});

test("③ Codex desktop-only: not on PATH, desktop bundle present and app-server-capable => available", async () => {
  clearCodexProbeCacheForTests();
  const h = harness({ onPath: {}, existing: [CODEX_DESKTOP] });
  const row = await rowFor("codex", h.hooks);

  assert.equal(row.state, "available", JSON.stringify(row));
  const gateProbes = h.probed.filter((p) => p.args[0] === "app-server").map((p) => p.command);
  assert.deepEqual(gateProbes, [CODEX_DESKTOP], "the desktop bundle must be the arbitrated candidate");
});

test("④ version-only / no-app-server: --version succeeds but the app-server gate fails => rejected", async () => {
  clearCodexProbeCacheForTests();
  const ONPATH = "/usr/local/bin/codex";
  const h = harness({
    onPath: { codex: ONPATH },
    existing: [],
    appServerOkFor: () => false, // gate fails; version read would still succeed
  });
  const row = await rowFor("codex", h.hooks);

  assert.notEqual(
    row.state,
    "available",
    `a version-only candidate must not be accepted: ${JSON.stringify(row)}`,
  );
  // Liveness: the gate really ran on the candidate (otherwise "rejected" proves nothing).
  assert.ok(
    h.probed.some((p) => p.command === ONPATH && p.args[0] === "app-server"),
    `app-server gate never ran; probed=${JSON.stringify(h.probed)}`,
  );
});

/**
 * Seam-liveness teeth. These exist so that a deps-disconnect mutant fails with a message
 * that NAMES the broken seam, rather than only showing a downstream `not_installed` row.
 */
test("⑤a seam live (Claude): the injected resolution deps are actually consumed", async () => {
  const h = harness({ onPath: {}, existing: [CLAUDE_DESKTOP], version: "1.2.3" });
  await rowFor("claude", h.hooks);

  assert.ok(
    h.whichAsked.length > 0,
    "injected PATH resolution was never consulted — the resolution deps are not reaching resolveClaudeCommand",
  );
  assert.ok(
    h.existsAsked.length > 0,
    "injected existsSyncFn was never consulted — the resolution deps are not reaching resolveClaudeCommand",
  );
});

test("⑤b seam live (Codex): the injected raw command runner is actually consumed", async () => {
  clearCodexProbeCacheForTests();
  const h = harness({ onPath: { codex: "/usr/local/bin/codex" }, existing: [] });
  await rowFor("codex", h.hooks);

  assert.ok(
    h.whichAsked.length > 0,
    "injected PATH resolution was never consulted — resolution deps are not reaching resolveCodexBin",
  );
  assert.ok(
    h.probed.length > 0,
    "injected runCommand was never consulted — the low-level runner is not reaching probeCommand",
  );
});
