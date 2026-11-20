import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { codexRuntime, createPiRuntime, type SessionOptions } from "../../packages/oar/src/index.js";
import { startCodexAimock, startPiAimock } from "../harness/aimock.js";
import { piRpcTestOptions } from "../harness/pi-rpc.js";
import { expectConfiguredAppend, initialInstruction, reopenedInstruction, hostAppend } from "./support/configured-append.js";

async function codexFixture() {
  const provider = await startCodexAimock(undefined, { captureRaw: true, warmHome: false });
  onTestFinished(async () => provider.stop());
  const home = provider.env?.CODEX_HOME;
  assert.ok(home !== undefined);
  const config = join(home, "config.toml");
  const original = await readFile(config, "utf8");
  const install = await codexRuntime.installation();
  assert.ok(install.kind === "available");
  return {
    raw: provider.raw,
    configure: async (value: string) => writeFile(config, `developer_instructions = "${value}"\n${original}`),
    open: async (options: Partial<SessionOptions>) => codexRuntime.session(install, { cwd: home, env: { ...provider.env }, ...options }),
  };
}

async function piFixture(projectTrusted: boolean) {
  const provider = await startPiAimock(undefined, { captureRaw: true });
  onTestFinished(async () => provider.stop());
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
    configure: async (value: string) => {
      await writeFile(join(agentDir, "APPEND_SYSTEM.md"), projectTrusted ? reopenedInstruction : value);
      await writeFile(join(project, "APPEND_SYSTEM.md"), projectTrusted ? value : reopenedInstruction);
    },
    open: async (options: Partial<SessionOptions>) => runtime.session(install, { cwd, model: "aimock/aimock-model", ...options }),
  };
}

// Each adapter supplies its own native instruction source and local provider.
// The contract is measured at the receiving model on every backend.
const backends = [
  { id: "codex-aimock", source: "developer_instructions", fixture: codexFixture },
  ...["pi-aimock", "pi-rpc-aimock"].flatMap(id => [
    { id, source: "trusted project APPEND_SYSTEM.md", fixture: async () => piFixture(true) },
    { id, source: "global APPEND_SYSTEM.md with an untrusted project", fixture: async () => piFixture(false) },
  ]),
];
for (const backend of backends) {
  test.skipIf(process.env.OAR_TEST !== backend.id)(`${backend.id} appends after ${backend.source}`, async () => {
    const f = await backend.fixture();
    await f.configure(initialInstruction);
    const session = await f.open({ appendSystemPrompt: hostAppend });
    try { await expectConfiguredAppend(session, f.raw, initialInstruction); } finally { await session.dispose(); }
  }, 120_000);
}

test.skipIf(process.env.OAR_TEST !== "codex-aimock").each(["resume", "fork"])(
  "Codex rereads configured instructions on cold %s", async method => {
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
