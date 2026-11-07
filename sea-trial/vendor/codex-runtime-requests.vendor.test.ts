/* oxlint-disable import/max-dependencies -- Drives one native app-server turn in a private directory. */
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { codexInstallation } from "../../packages/oar/src/index.js";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { codexRequestReply } from "../../packages/oar/src/runtimes/codex/runtime-requests.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { removeFixtureDirectory } from "../harness/fixture-directory-cleanup.js";
import { startCodexAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

/**
 * OAR opens with `approvalPolicy: never`, so this drives the app-server
 * directly under a policy that asks, to see codex accept OAR's reply.
 */
describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex accepts OAR's refusal of its requests", () => {
  test("a declined command approval does not run the command and the turn completes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oar-codex-refusal-"));
    const target = path.join(directory, "written");
    let calls = 0;
    const env = await startCodexAimock((mock) => {
      mock.on({ predicate: () => { calls += 1; return calls === 1; } }, { toolCalls: [{ name: "exec_command", arguments: JSON.stringify({ cmd: `touch ${JSON.stringify(target)}` }) }] });
      mock.onMessage(/[\s\S]*/u, { content: "done" });
    });
    const installation = await codexInstallation();
    expectAvailable(installation, "codex");
    if (installation.via !== "executable") { throw new Error("codex needs its executable"); }
    const client = startAppServerClient(installation.command, env.env, {}, directory);
    const asked: string[] = [];
    try {
      const { promise: completed, resolve } = Promise.withResolvers<unknown>();
      client.handle({
        onNotification: (method, params) => { if (method === "turn/completed") { resolve(asRecord(params.turn)?.status); } },
        onServerRequest: (id, method) => { asked.push(method); client.respond(id, codexRequestReply(method)); },
      });
      await client.request("initialize", { clientInfo: { name: "oar-vendor", version: "0" }, capabilities: { experimentalApi: true } });
      client.notify("initialized", {});
      const started = await client.request("thread/start", { cwd: directory, approvalPolicy: "untrusted", sandbox: "read-only" });
      await client.request("turn/start", { threadId: asRecord(started.thread)?.id, input: [{ type: "text", text: "write it", text_elements: [] }] });
      expect(await completed).toBe("completed");
      expect(asked).toContain("item/commandExecution/requestApproval");
      expect(existsSync(target)).toBe(false);
    } finally {
      client.kill();
      await client.exited;
      await env.stop();
      await removeFixtureDirectory(directory, "codex-runtime-requests");
    }
  }, 90_000);
});
