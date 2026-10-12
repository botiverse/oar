import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

/** The titles claude reports for the session (`session_title_changed`, at startup and on a rename). */
function titles(session: Session): unknown[] {
  return session.records().flatMap((record) => {
    const native = record.kind === "frame" ? asRecord(record.body.native) : null;
    return native?.subtype === "session_title_changed" ? [native.title] : [];
  });
}

/** SessionOptions.name (#368): `--name` on a new session only, so a resume keeps the name the session has. */
describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude session name", () => {
  test("a new session is named and a resume keeps its name", async () => {
    const env = await startClaudeAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "pong" });
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-claude-name-"));
    const config = await mkdtemp(path.join(tmpdir(), "oar-claude-config-"));
    const sessionEnv = { ...env.env, CLAUDE_CONFIG_DIR: config };
    try {
      const installation = await claudeInstallation();
      expectAvailable(installation, "claude");
      const first = await claudeSession(installation, { cwd, env: sessionEnv, name: "OAR vendor" });
      expect(await promptAndWait(first, "first")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(titles(first)).toEqual(["OAR vendor"]);
      const id = first.id;
      await first.dispose();

      const resumed = await claudeSession(installation, { cwd, env: sessionEnv, resume: id, name: "replacement" });
      expect(await promptAndWait(resumed, "again")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(titles(resumed)).toEqual(["OAR vendor"]);
      await resumed.dispose();
    } finally {
      await env.stop();
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
      await rm(config, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 120_000);
});
