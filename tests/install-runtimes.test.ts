/* oxlint-disable import/max-dependencies -- Covered runtimes plus filesystem/env fixtures for Devin install planning. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { createCursorRuntime, defaultRuntimes } from "../packages/oar/src/index.js";
import { antigravityInstallMethod } from "../packages/oar/src/runtimes/antigravity/install.js";
import { claudeInstallMethod } from "../packages/oar/src/runtimes/claude/install.js";
import { codexInstallMethod } from "../packages/oar/src/runtimes/codex/install.js";
import { createDevinInstallPlan, devinInstallMethod, devinInstallPlan } from "../packages/oar/src/runtimes/devin/install.js";
import { grokInstallMethod } from "../packages/oar/src/runtimes/grok/install.js";
import { kimiInstallMethod } from "../packages/oar/src/runtimes/kimi/install.js";
import { opencodeInstallMethods, opencodeInstallPlan, opencodeLineOf } from "../packages/oar/src/runtimes/opencode/install.js";
import { scriptInstallPlanOn, type InstallHost, type ScriptInstallMethod } from "../packages/oar/src/shared/install.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const linux: InstallHost = {
  platform: "linux",
  arch: "arm64",
  locate: (tool) => `/usr/bin/${tool}`,
  unwritable: () => null,
};

test("each built-in script install runs its vendor's documented line, cited by its documentation page", () => {
  const methods: Record<string, readonly [ScriptInstallMethod | undefined, string, string]> = {
    antigravity: [antigravityInstallMethod, "curl -fsSL https://antigravity.google/cli/install.sh | bash", "https://antigravity.google/docs/cli"],
    claude: [claudeInstallMethod, "curl -fsSL https://claude.ai/install.sh | bash", "https://code.claude.com/docs/en/setup"],
    codex: [codexInstallMethod, "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh", "https://github.com/openai/codex#installing-and-running-codex-cli"],
    devin: [devinInstallMethod, "curl -fsSL https://cli.devin.ai/install.sh | bash", "https://docs.devin.ai/cli"],
    grok: [grokInstallMethod, "curl -fsSL https://x.ai/cli/install.sh | bash", "https://docs.x.ai/build/overview"],
    kimi: [kimiInstallMethod, "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash", "https://github.com/MoonshotAI/kimi-code#install"],
    "opencode v1": [opencodeInstallMethods.v1, "curl -fsSL https://opencode.ai/install | bash", "https://opencode.ai/docs/#install"],
    "opencode v2": [opencodeInstallMethods.v2, "curl -fsSL https://opencode.ai/v2/install | bash", "https://opencode.ai/v2/docs/"],
  };
  for (const [id, [scripted, line, source]] of Object.entries(methods)) {
    assert.ok(scripted !== undefined, id);
    const plan = scriptInstallPlanOn(scripted, linux);
    assert.deepEqual(plan.kind === "plan" ? [plan.steps.map((step) => step.display), plan.source] : plan, [[line], source], id);
  }
});

test("an install location variable is where privileges are checked, and the answer keeps the vendor's line", () => {
  const previous = process.env.KIMI_INSTALL_DIR;
  process.env.KIMI_INSTALL_DIR = "/usr/local";
  try {
    const plan = scriptInstallPlanOn(kimiInstallMethod, { ...linux, unwritable: (target) => (target.startsWith("/usr/local") ? "/usr/local" : null) });
    assert.equal(plan.kind === "unsupported" ? plan.reason : plan.kind, "requires_privileges");
    assert.deepEqual(plan.kind === "unsupported" ? [plan.steps?.map((step) => step.display), plan.source] : plan, [
      ["curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"],
      "https://github.com/MoonshotAI/kimi-code#install",
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.KIMI_INSTALL_DIR;
    } else {
      process.env.KIMI_INSTALL_DIR = previous;
    }
  }
});

test("install and installPlan come together, and a bundled runtime has neither", () => {
  const cursor = createCursorRuntime({ sdk: async () => import("@cursor/sdk") });
  for (const runtime of [...defaultRuntimes.list(), cursor]) {
    assert.equal(runtime.install === undefined, runtime.installPlan === undefined, runtime.id);
  }
  assert.deepEqual(
    [...defaultRuntimes.list(), cursor].filter((runtime) => runtime.install === undefined).map((runtime) => runtime.id),
    ["pi", "cursor"],
  );
});

test("opencode ships two lines and oar picks neither: the plan needs a line", async () => {
  assert.deepEqual(defaultRuntimes.list().filter((runtime) => runtime.installLines !== undefined).map((runtime) => [runtime.id, runtime.installLines?.map((entry) => entry.line)]), [
    ["opencode", ["v1", "v2"]],
  ]);
  const unchosen = await opencodeInstallPlan();
  assert.equal(unchosen.kind === "unsupported" ? unchosen.reason : unchosen.kind, "line_required");
  const unknown = await opencodeInstallPlan({ line: "v3" });
  assert.equal(unknown.kind === "unsupported" ? unknown.reason : unknown.kind, "unknown_line");
  // Without a line it ships, there is no vendor step to show.
  for (const answer of [unchosen, unknown]) {
    assert.deepEqual([Object.hasOwn(answer, "steps"), Object.hasOwn(answer, "source")], [false, false], JSON.stringify(answer));
  }
  // A plan for v2 here, or this machine's own answer (platform on Windows), never line_required.
  const v2 = await opencodeInstallPlan({ line: "v2" });
  assert.equal(v2.kind === "plan" ? v2.source : v2.reason === "line_required", v2.kind === "plan" ? "https://opencode.ai/v2/docs/" : false);
});

test("a runtime with one line refuses a line rather than ignore it", async () => {
  const plan = await defaultRuntimes.require("claude").installPlan?.({ line: "v2" });
  assert.equal(plan?.kind === "unsupported" ? plan.reason : plan?.kind, "unknown_line");
});

function found(version: string) {
  return { kind: "available", via: "executable", command: "opencode", version } as const;
}

test("an opencode installation's line is its major version", () => {
  assert.equal(opencodeLineOf(found("1.18.35")), "v1");
  assert.equal(opencodeLineOf(found("opencode v2.0.26")), "v2");
  assert.equal(opencodeLineOf(found("opencode v3.0.0")), undefined);
  assert.equal(opencodeLineOf({ kind: "available", via: "bundled" }), undefined);
});

test("Antigravity's optional shell-profile update does not require write permission", () => {
  const plan = scriptInstallPlanOn(antigravityInstallMethod, {
    ...linux, unwritable: (target) => target.endsWith(".bashrc") || target.endsWith(".zshrc") ? target : null,
  });
  assert.equal(plan.kind, "plan");
});

test("devin checks write privileges under XDG_DATA_HOME", () => {
  vi.stubEnv("XDG_DATA_HOME", "/opt/xdg-data");
  const blocked = scriptInstallPlanOn(devinInstallMethod, {
    ...linux,
    unwritable: (target) => (target.startsWith("/opt/xdg-data") ? "/opt/xdg-data" : null),
  });
  assert.equal(blocked.kind === "unsupported" ? blocked.reason : blocked.kind, "requires_privileges");
  const allowed = scriptInstallPlanOn(devinInstallMethod, linux);
  assert.equal(allowed.kind, "plan");
});

function writeStubbedTools(home: string): string {
  const toolsDir = path.join(home, "tools");
  mkdirSync(toolsDir, { recursive: true });
  for (const tool of ["sh", "curl", "bash"]) {
    const file = path.join(toolsDir, process.platform === "win32" ? `${tool}.cmd` : tool);
    writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
  }
  return toolsDir;
}

async function withStubbedHome(prefix: string, run: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("PATH", writeStubbedTools(home));
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("devinInstallPlan refuses missing OAR_DEVIN_BIN override", async () => {
  await withStubbedHome("oar-devin-override-", async (home) => {
    vi.stubEnv("OAR_DEVIN_BIN", path.join(home, "missing-devin"));
    const missing = await devinInstallPlan();
    assert.equal(missing.kind, "unsupported");
    assert.equal(missing.reason, "configuration");
    assert.match(missing.detail ?? "", /OAR_DEVIN_BIN/u);
  });
});

test("devinInstallPlan refuses non-Devin OAR_DEVIN_BIN override", async () => {
  await withStubbedHome("oar-devin-unsupported-", async () => {
    vi.stubEnv("OAR_DEVIN_BIN", process.execPath);
    const unsupported = await devinInstallPlan();
    assert.equal(unsupported.kind, "unsupported");
    assert.equal(unsupported.reason, "configuration");
  });
});

test.skipIf(process.platform === "win32")("devinInstallPlan refuses a regular non-symlink ~/.local/bin/devin", async () => {
  await withStubbedHome("oar-devin-regular-file-", async (home) => {
    vi.stubEnv("OAR_DEVIN_BIN", "");
    const binDir = path.join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "devin"), "regular-file-not-a-symlink");
    const plan = await devinInstallPlan();
    assert.equal(plan.kind, "unsupported");
    assert.equal(plan.reason, "configuration");
    assert.match(plan.detail ?? "", /not a symlink/u);
  });
});

test("devinInstallPlan preserves earlier unsupported base plans instead of overriding with local configuration checks", async () => {
  await withStubbedHome("oar-devin-base-unsupported-", async (home) => {
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    writeFileSync(path.join(home, ".local", "bin", "devin"), "regular-file-not-a-symlink");
    vi.stubEnv("OAR_DEVIN_BIN", path.join(home, "missing-devin"));
    const winPlan = await createDevinInstallPlan({ ...linux, platform: "win32" })();
    assert.equal(winPlan.kind === "unsupported" ? winPlan.reason : winPlan.kind, "platform");
    vi.stubEnv("OAR_DEVIN_BIN", "");
    const missingToolPlan = await createDevinInstallPlan({ ...linux, locate: () => null })();
    assert.equal(missingToolPlan.kind === "unsupported" ? missingToolPlan.reason : missingToolPlan.kind, "missing_tool");
  });
});
