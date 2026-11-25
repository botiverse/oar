/* oxlint-disable import/max-dependencies -- Exercises real codex app-server sessions with scripted model turns. */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { codexRuntime, eventsOf, type RawEvent } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../harness/aimock.js";
import { removeFixtureDirectory } from "../harness/fixture-directory-cleanup.js";
import { expectAvailable, runTurn, withProcessEnv } from "./support/asserts.js";

const codexInstallation = codexRuntime.installation;
const codexSession = codexRuntime.session;

function openNative(records: readonly RawEvent[], method: "thread/start" | "thread/resume"): Record<string, unknown> | null {
  for (const record of records) {
    if (record.kind === "frame" && record.body.type === method) {
      return asRecord(record.body.native);
    }
  }
  return null;
}

/** Prepend top-level TOML keys before any `[table]` header in `config.toml`. */
async function prependTopLevelConfig(codexHome: string, lines: readonly string[]): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");
  const existing = await readFile(configPath, "utf8");
  await writeFile(configPath, `${lines.join("\n")}\n${existing}`);
}

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex SessionOptions.nativePermissions inherit", () => {
  test("start and resume inherit sandbox_mode, approval_policy, and approvals_reviewer from CODEX_HOME/config.toml over OAR_CODEX_SANDBOX", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oar-codex-native-perms-"));
    const env = await startCodexAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "ok" });
    });
    const aimockEnv = env.env;
    const codexHome = aimockEnv?.CODEX_HOME;
    if (aimockEnv === undefined || codexHome === undefined) { throw new Error("startCodexAimock returned no CODEX_HOME"); }
    await prependTopLevelConfig(codexHome, [
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      'approvals_reviewer = "guardian_subagent"',
    ]);
    const installation = await codexInstallation();
    expectAvailable(installation, "codex");
    // On Windows without Codex's Windows sandbox enabled, Codex's
    // effective_sandbox_mode downgrades workspace-write to readOnly
    // (same rule as additional-directories.vendor.test.ts).
    const expectedSandbox = process.platform === "win32" ? "readOnly" : "workspaceWrite";
    try {
      await withProcessEnv({ OAR_CODEX_SANDBOX: "danger-full-access" }, async () => {
        const started = await codexSession(installation, {
          cwd: directory,
          env: aimockEnv,
          nativePermissions: "inherit",
        });
        let threadId = "";
        try {
          const startFrame = openNative(started.records(), "thread/start");
          expect(startFrame).toMatchObject({
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: { type: expectedSandbox },
          });
          // Run one turn so codex writes the thread rollout for resume.
          const firstTurn = await runTurn(started, "hello");
          expect(firstTurn.kind).toBe("completed");
          threadId = started.id;
        } finally {
          await started.dispose();
        }

        const resumedInherit = await codexSession(installation, {
          cwd: directory,
          env: aimockEnv,
          resume: threadId,
          nativePermissions: "inherit",
        });
        try {
          const resumeFrame = openNative(resumedInherit.records(), "thread/resume");
          expect(resumeFrame).toMatchObject({
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: { type: expectedSandbox },
          });
        } finally {
          await resumedInherit.dispose();
        }

        const resumedDefault = await codexSession(installation, {
          cwd: directory,
          env: aimockEnv,
          resume: threadId,
        });
        try {
          const resumeFrame = openNative(resumedDefault.records(), "thread/resume");
          expect(resumeFrame).toMatchObject({
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
          });
        } finally {
          await resumedDefault.dispose();
        }
      });
    } finally {
      await env.stop();
      await removeFixtureDirectory(directory, "codex-native-permissions");
    }
  }, 120_000);

  test("inherited on-request with user reviewer records app_request and app_answered and declines without hanging", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oar-codex-native-perms-decline-"));
    const target = path.join(directory, "should-not-exist");
    let calls = 0;
    const env = await startCodexAimock((mock) => {
      mock.on({ predicate: () => { calls += 1; return calls === 1; } }, {
        toolCalls: [{
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: `touch ${JSON.stringify(target)}`,
            sandbox_permissions: "require_escalated",
            justification: "test inherited approval refusal",
          }),
        }],
      });
      mock.onMessage(/[\s\S]*/u, { content: "done" });
    });
    const aimockEnv = env.env;
    const codexHome = aimockEnv?.CODEX_HOME;
    if (aimockEnv === undefined || codexHome === undefined) { throw new Error("startCodexAimock returned no CODEX_HOME"); }
    await prependTopLevelConfig(codexHome, [
      'sandbox_mode = "read-only"',
      'approval_policy = "on-request"',
      'approvals_reviewer = "user"',
    ]);
    const installation = await codexInstallation();
    expectAvailable(installation, "codex");
    try {
      const session = await codexSession(installation, {
        cwd: directory,
        env: aimockEnv,
        nativePermissions: "inherit",
      });
      let threadId = "";
      try {
        const startFrame = openNative(session.records(), "thread/start");
        expect(startFrame).toMatchObject({
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly" },
        });
        const turn = await runTurn(session, "write the file");
        expect(turn.kind).toBe("completed");
        expect(existsSync(target)).toBe(false);
        const records = session.records();
        const allEvents = records.flatMap((record) => eventsOf(record));
        const approvalRequest = allEvents.find((event) => event.kind === "app_request" && event.type === "item/commandExecution/requestApproval");
        expect(approvalRequest).toBeDefined();
        const requestId = approvalRequest?.kind === "app_request" ? approvalRequest.requestId : undefined;
        const approvalAnswerEvent = allEvents.find((event) => event.kind === "app_answered" && event.requestId === requestId);
        expect(approvalAnswerEvent).toBeDefined();
        const approvalAnswerRecord = records.find((record) => record.kind === "response" && record.requestId === requestId && record.body.kind === "answered");
        expect(approvalAnswerRecord?.kind === "response" ? approvalAnswerRecord.body : undefined).toMatchObject({
          kind: "answered",
          native: { result: { decision: "decline" } },
        });
        threadId = session.id;
      } finally {
        await session.dispose();
      }

      const resumedDefault = await codexSession(installation, {
        cwd: directory,
        env: aimockEnv,
        resume: threadId,
      });
      try {
        const resumeFrame = openNative(resumedDefault.records(), "thread/resume");
        expect(resumeFrame).toMatchObject({
          approvalPolicy: "never",
          sandbox: { type: "dangerFullAccess" },
        });
      } finally {
        await resumedDefault.dispose();
      }
    } finally {
      await env.stop();
      await removeFixtureDirectory(directory, "codex-native-permissions-decline");
    }
  }, 120_000);
});
