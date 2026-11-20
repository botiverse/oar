import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { codexRuntime, createPiRuntime, type SessionOptions } from "../../packages/oar/src/index.js";
import { startCodexAimock, startPiAimock } from "../harness/aimock.js";
import { piRpcTestOptions } from "../harness/pi-rpc.js";
import { expectConfiguredAppend, hostAppend, initialInstruction, reopenedInstruction, type ConfiguredAppendFixture } from "./support/configured-append.js";
import { antigravityConfiguredFixture, grokConfiguredFixture, qoderConfiguredFixture } from "./support/configured-append-acp.js";
import { dshConfiguredFixture, factoryConfiguredFixture, piDurableConfiguredFixture } from "./support/configured-append-native.js";

async function codexFixture(): Promise<ConfiguredAppendFixture> {
  const provider = await startCodexAimock(undefined, { captureRaw: true, warmHome: false });
  onTestFinished(async () => { await provider.stop(); });
  const home = provider.env?.CODEX_HOME;
  assert.ok(home !== undefined);
  const config = join(home, "config.toml");
  const original = await readFile(config, "utf8");
  const install = await codexRuntime.installation();
  assert.ok(install.kind === "available");
  return {
    raw: provider.raw,
    placement: "system",
    configure: async (value: string) => { await writeFile(config, `developer_instructions = "${value}"\n${original}`); },
    open: async (options: Partial<SessionOptions>) => {
      const session = await codexRuntime.session(install, { cwd: home, env: { ...provider.env }, ...options });
      return session;
    },
  };
}

async function piFixture(projectTrusted: boolean): Promise<ConfiguredAppendFixture> {
  const provider = await startPiAimock(undefined, { captureRaw: true });
  onTestFinished(async () => { await provider.stop(); });
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(agentDir !== undefined);
  const cwd = join(agentDir, "project");
  const project = join(cwd, ".pi");
  await mkdir(project, { recursive: true });
  const runtime = createPiRuntime({ ...(process.env.OAR_TEST === "pi-rpc-aimock" ? piRpcTestOptions() : { execution: "in-process" }), projectTrusted });
  const install = await runtime.installation();
  assert.ok(install.kind === "available");
  return {
    raw: provider.raw,
    placement: "system",
    configure: async (value: string) => {
      await writeFile(join(agentDir, "APPEND_SYSTEM.md"), projectTrusted ? reopenedInstruction : value);
      await writeFile(join(project, "APPEND_SYSTEM.md"), projectTrusted ? value : reopenedInstruction);
    },
    open: async (options: Partial<SessionOptions>) => {
      const session = await runtime.session(install, { cwd, model: "aimock/aimock-model", ...options });
      return session;
    },
  };
}

// Each adapter supplies its own native instruction source and local provider.
// The contract is measured at the receiving model on every backend.
const backends: readonly { readonly id: string; readonly source: string; readonly fixture: () => Promise<ConfiguredAppendFixture> }[] = [
  { id: "codex-aimock", source: "developer_instructions", fixture: codexFixture },
  ...["pi-aimock", "pi-rpc-aimock"].flatMap((id) => [
    { id, source: "trusted project APPEND_SYSTEM.md", fixture: async () => { const f = await piFixture(true); return f; } },
    { id, source: "global APPEND_SYSTEM.md with an untrusted project", fixture: async () => { const f = await piFixture(false); return f; } },
  ]),
  { id: "antigravity-aimock", source: "global GEMINI.md", fixture: antigravityConfiguredFixture },
  { id: "dsh-aimock", source: "system-prompt personaSuffix", fixture: dshConfiguredFixture },
  { id: "factory-aimock", source: "global AGENTS.md", fixture: factoryConfiguredFixture },
  { id: "grok-aimock", source: "global AGENTS.md", fixture: grokConfiguredFixture },
  { id: "pi-durable-aimock", source: "extension prompt section", fixture: piDurableConfiguredFixture },
  { id: "qoder-native", source: "global AGENTS.md", fixture: qoderConfiguredFixture },
];
for (const backend of backends) {
  test.skipIf(process.env.OAR_TEST !== backend.id)(`${backend.id} appends after ${backend.source}`, async () => {
    const f = await backend.fixture();
    await f.configure(initialInstruction);
    const session = await f.open({ appendSystemPrompt: hostAppend });
    try {
      await expectConfiguredAppend(session, f.raw, initialInstruction, {
        ...(f.placement === undefined ? {} : { placement: f.placement }),
        ...(f.captureTurn === undefined ? {} : { captureTurn: f.captureTurn }),
      });
    } finally { await session.dispose(); }
  }, 120_000);
}

test.skipIf(process.env.OAR_TEST !== "codex-aimock").each(["resume", "fork"])(
  "Codex rereads configured instructions on cold %s", async (method) => {
    const f = await codexFixture();
    await f.configure(initialInstruction);
    const seed = await f.open({ appendSystemPrompt: hostAppend });
    try { await expectConfiguredAppend(seed, f.raw, initialInstruction); } finally { await seed.dispose(); }
    await f.configure(reopenedInstruction);
    const reopened = await f.open({ resume: seed.id, ...(method === "fork" ? { fork: {} } : {}), appendSystemPrompt: hostAppend });
    try {
      const compact = await reopened.compact?.({ timeoutMs: 30_000 });
      expect(compact?.kind).toBe("completed");
      await expectConfiguredAppend(reopened, f.raw, reopenedInstruction);
    } finally { await reopened.dispose(); }
  }, 120_000,
);
