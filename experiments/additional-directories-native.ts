/* oxlint-disable no-await-in-loop -- Each native resume follows its new session and process shutdown. */
/**
 * Claude's native environment text and Codex workspace-root readback on all
 * three sandbox modes. Uses isolated provider/configuration, no account.
 * OAR_CLAUDE_BIN=... OAR_CODEX_BIN=... pnpm tsx experiments/additional-directories-native.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeSession } from "../packages/oar/src/runtimes/claude/session.js";
import { startAppServerClient, type AppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { promptAndWait } from "../packages/oar/src/observe/turns.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../sea-trial/harness/aimock.js";

async function claude(cwd: string, extra: string, home: string): Promise<void> {
  const provider = await startClaudeAimock(undefined, { captureRaw: true });
  try {
    const installation = { kind: "available", via: "executable", command: process.env.OAR_CLAUDE_BIN ?? "claude" } as const;
    for (const enabled of [false, true]) {
    const session = await claudeSession(installation, { cwd, env: { ...provider.env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: enabled ? "1" : null }, additionalDirectories: [extra] });
    try {
      const result = await promptAndWait(session, "Say ok", { timeoutMs: 30_000 });
      assert.equal(result.kind, "ended");
      assert.ok(JSON.stringify(provider.raw.at(-1)?.body).includes(JSON.stringify(extra).slice(1, -1)));
      const loaded = JSON.stringify(provider.raw.at(-1)?.body).includes("OAR_EXTRA_RULE_729");
      assert.equal(loaded, enabled);
      console.log(`PASS Claude extra directory known; CLAUDE.md loaded=${String(loaded)}, opt-in=${String(enabled)}`);
    } finally { await session.dispose(); }
    }
  } finally { await provider.stop(); }
}

async function initialize(client: AppServerClient): Promise<void> {
  await client.request("initialize", { clientInfo: { name: "oar-probe", version: "1" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});
}

async function codex(cwd: string, extra: string): Promise<void> {
  const provider = await startCodexAimock();
  try {
    for (const sandbox of ["workspace-write", "danger-full-access", "read-only"]) {
      const start = (): AppServerClient => startAppServerClient(process.env.OAR_CODEX_BIN ?? "codex", provider.env, { sandbox_mode: JSON.stringify(sandbox) });
      let client = start();
      try {
        await initialize(client);
        const opened = await client.request("thread/start", { cwd, model: "gpt-5.1", approvalPolicy: "never", runtimeWorkspaceRoots: [cwd, extra] });
        const threadId = asRecord(opened.thread)?.id;
        assert.deepEqual(opened.runtimeWorkspaceRoots, [cwd, extra]);
        const settled = Promise.withResolvers<void>();
        client.handle({ onNotification: (method) => { if (method === "turn/completed") { settled.resolve(); } }, onServerRequest: () => {} });
        const timer = setTimeout(() => { settled.reject(new Error("turn did not end within 30 seconds")); }, 30_000);
        try {
          await client.request("turn/start", { threadId, input: [{ type: "text", text: "Say ok", text_elements: [] }] });
          await settled.promise;
        } finally { clearTimeout(timer); }
        // Codex creates rollout material at the first turn. A loaded thread
        // can ignore overrides; OAR always resumes in a fresh process.
        client.kill(); await client.exited;
        client = start();
        await initialize(client);
        const resumed = await client.request("thread/resume", { threadId, cwd, runtimeWorkspaceRoots: [cwd] });
        assert.deepEqual(resumed.runtimeWorkspaceRoots, [cwd]);
        assert.equal(asRecord(resumed.sandbox)?.type, asRecord(opened.sandbox)?.type);
        console.log(`PASS Codex new/cold resume roots, ${sandbox} unchanged`);
      } finally { client.kill(); await client.exited; }
    }
  } finally { await provider.stop(); }
}

const root = await mkdtemp(path.join(tmpdir(), "oar-extra-directories-"));
try {
  const cwd = path.join(root, "project");
  const extra = path.join(root, "extra");
  await Promise.all([mkdir(cwd), mkdir(extra)]);
  await writeFile(path.join(extra, "CLAUDE.md"), "OAR_EXTRA_RULE_729: A harmless directory verification marker.\n");
  await claude(cwd, extra, path.join(root, "claude-home"));
  await codex(cwd, extra);
} finally { await rm(root, { recursive: true, force: true }); }
