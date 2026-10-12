import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession, promptAndWait, SessionUnavailableError } from "../../packages/oar/src/index.js";
import { startAppServerClient, type AppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

function nameOf(reply: unknown): unknown {
  return asRecord(asRecord(reply)?.thread)?.name;
}

async function close(client: AppServerClient): Promise<void> {
  client.kill();
  await client.exited;
}

/**
 * SessionOptions.name and the unavailable resume targets (#368) against the
 * real codex: a second app-server stands in for the user's Codex app, which
 * reads the name, holds the thread, and archives it.
 */
describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex session name and unavailable resume targets", () => {
  test("a new thread is named, a held or archived one is refused by reason, and an unarchived one resumes", async () => {
    const env = await startCodexAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "pong" });
    });
    const sessionEnv = env.env ?? {};
    const installation = await codexInstallation();
    expectAvailable(installation, "codex");
    if (installation.via !== "executable") { throw new Error("codex needs its executable"); }
    const command = installation.command;
    async function app(): Promise<AppServerClient> {
      const client = startAppServerClient(command, sessionEnv);
      client.handle({ onNotification: () => {}, onServerRequest: () => {} });
      await client.request("initialize", { clientInfo: { name: "oar-vendor", version: "0" }, capabilities: { experimentalApi: true } });
      client.notify("initialized", {});
      return client;
    }
    try {
      const first = await codexSession(installation, { cwd: process.cwd(), env: sessionEnv, name: "OAR vendor" });
      await promptAndWait(first, "first");
      const id = first.id;
      await first.dispose();

      const holder = await app();
      expect(nameOf(await holder.request("thread/read", { threadId: id }))).toBe("OAR vendor");
      await holder.request("thread/resume", { threadId: id });
      await expect(codexSession(installation, { cwd: process.cwd(), env: sessionEnv, resume: id })).rejects.toMatchObject({ name: "SessionUnavailableError", reason: "in_use", sessionId: id });
      await close(holder);

      const archiver = await app();
      await archiver.request("thread/archive", { threadId: id });
      await close(archiver);
      const archived: unknown = await codexSession(installation, { cwd: process.cwd(), env: sessionEnv, resume: id }).catch((error: unknown) => error);
      expect(archived).toBeInstanceOf(SessionUnavailableError);
      expect(archived).toMatchObject({ reason: "archived", sessionId: id });

      const unarchiver = await app();
      await unarchiver.request("thread/unarchive", { threadId: id });
      await close(unarchiver);
      // A resume names only an unnamed thread: the existing name stays.
      const resumed = await codexSession(installation, { cwd: process.cwd(), env: sessionEnv, resume: id, name: "replacement" });
      expect(await promptAndWait(resumed, "again")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      await resumed.dispose();
      const reader = await app();
      expect(nameOf(await reader.request("thread/read", { threadId: id }))).toBe("OAR vendor");
      await close(reader);

      // An unnamed thread is named on resume.
      const unnamed = await codexSession(installation, { cwd: process.cwd(), env: sessionEnv });
      await promptAndWait(unnamed, "unnamed");
      const unnamedId = unnamed.id;
      await unnamed.dispose();
      const named = await codexSession(installation, { cwd: process.cwd(), env: sessionEnv, resume: unnamedId, name: "named on resume" });
      await named.dispose();
      const checker = await app();
      expect(nameOf(await checker.request("thread/read", { threadId: unnamedId }))).toBe("named on resume");
      await close(checker);
    } finally {
      await env.stop();
    }
  }, 180_000);
});
