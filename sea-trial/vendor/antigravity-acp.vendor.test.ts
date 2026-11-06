/* oxlint-disable import/max-dependencies -- Native controls compare provider fields, session lifecycle, MCP and real directory identity. */
import { sameDirectory } from "../../packages/oar/src/shared/same-directory.js";
/* oxlint-disable typescript/promise-function-async -- Native provider callbacks may return an immediate scripted reply. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { antigravityRuntime, type Session } from "../../packages/oar/src/index.js";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord, asRecordList } from "../../packages/oar/src/shared/json.js";
import { startAntigravityAimock } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { ECHO_SERVER } from "./support/echo-mcp.js";

describe.skipIf(process.env.OAR_TEST !== "antigravity-aimock")("agy native ACP", () => {
  test("model discovery reads the native catalog without sending a prompt", async () => {
    const env = await startAntigravityAimock(() => {});
    try {
      const installation = await antigravityRuntime.installation();
      assert.ok(installation.kind === "available", JSON.stringify(installation));
      const cwd = env.env.HOME; assert.ok(cwd !== undefined);
      const result = await antigravityRuntime.listModels(installation, { cwd, env: env.env });
      assert.ok(result.kind === "ok", JSON.stringify(result));
      expect(result.models.some((model) => model.id === "gemini-3.8-flash")).toBe(true);
      expect(result.models.filter((model) => model.default)).toHaveLength(1);
      expect(result.models.find((model) => model.default)?.effortLevels).toContain("low");
      expect(env.raw).toHaveLength(0);
    } finally { await env.stop(); }
  }, 60_000);

  test("a steer supersedes the early prompt reply and stays in the same native model loop", async () => {
    const firstModel = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const earlierReply = Promise.withResolvers<void>();
    const mainRequests: string[] = [];
    const env = await startAntigravityAimock((mock) => {
      mock.on({ predicate: () => true }, async (request) => {
        const body = JSON.stringify(request.messages);
        if (body.includes("You are a conversation title generator")) { return { content: "Steer test" }; }
        mainRequests.push(body);
        if (body.includes("echo:agy-steered")) { return { content: "SAME_LOOP_COMPLETE" }; }
        firstModel.resolve();
        await release.promise;
        return { toolCalls: [{ id: "agy-echo", name: "mcp_echo_echo", arguments: JSON.stringify({ text: "agy-steered", toolSummary: "Echo test input" }) }] };
      });
    });
    let session: Session | undefined = undefined;
    try {
      session = await runtimeUnderTest(antigravityRuntime, env.env).startSession({ mcpServers: [{ name: "echo", command: process.execPath, args: [ECHO_SERVER] }] });
      session.rawEvents((record) => { if (record.kind === "frame" && record.body.type === "session/prompt") { earlierReply.resolve(); } });
      const original = await session.prompt("AGY_INITIAL_TURN");
      await firstModel.promise;
      assert.ok(session.steer !== undefined);
      const steered = await session.steer("AGY_STEER_INSIDE_LOOP");
      expect(steered.response.body.kind).toBe("accepted");
      await earlierReply.promise;
      // agy answers the original prompt as soon as it accepts the steer,
      // while the first provider response is still held. That is not idle.
      expect(session.status().value.kind).toBe("running");
      expect(session.records().some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "turn_ended"))).toBe(false);
      const premature = await session.prompt("MUST_NOT_START");
      expect(premature.response.body).toMatchObject({ kind: "rejected", code: "busy" });
      release.resolve();
      expect(await awaitTurnEnd(session, original.request.seq)).toEqual({ kind: "completed" });
      expect(mainRequests).toHaveLength(2);
      expect(mainRequests[0]).not.toContain("AGY_STEER_INSIDE_LOOP");
      expect(mainRequests[1]).toContain("AGY_INITIAL_TURN");
      expect(mainRequests[1]).toContain("AGY_STEER_INSIDE_LOOP");
      expect(mainRequests[1]).toContain("echo:agy-steered");
      expect(mainRequests[1]).not.toContain("MUST_NOT_START");
      expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "turn_ended") : [])).toHaveLength(1);
    } finally { release.resolve(); await session?.dispose(); await env.stop(); }
  }, 60_000);

  test("resume retains the primary cwd and additional directories cannot replace it", async () => {
    const env = await startAntigravityAimock((mock) => { mock.onMessage(/AGY_WORKSPACE/u, { content: "AGY_WORKSPACE_OK" }); });
    const installation = await antigravityRuntime.installation();
    assert.ok(installation.kind === "available", JSON.stringify(installation));
    const home = env.env.HOME; assert.ok(home !== undefined);
    const cwd = path.join(home, "original");
    const extra = path.join(home, "extra");
    await Promise.all([cwd, extra].map(async (dir) => mkdir(dir)));
    let session: Session | undefined = undefined;
    try {
      await expect(antigravityRuntime.session(installation, { cwd, env: env.env, additionalDirectories: [extra] })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "additionalDirectories" });
      expect(env.raw).toHaveLength(0);
      session = await antigravityRuntime.session(installation, { cwd, env: env.env });
      const unprompted = session.id;
      await session.dispose();
      await expect(antigravityRuntime.session(installation, { cwd: extra, env: env.env, resume: unprompted })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "cwd" });
      expect(env.raw).toHaveLength(0);
      session = await antigravityRuntime.session(installation, { cwd, env: env.env });
      expect(await promptAndWait(session, "AGY_WORKSPACE_INITIAL")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const id = session.id;
      await session.dispose();
      const before = env.raw.length;
      await expect(antigravityRuntime.session(installation, { cwd: extra, env: env.env, resume: id })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "cwd" });
      expect(env.raw).toHaveLength(before);
      session = await antigravityRuntime.session(installation, { cwd, env: env.env, resume: id });
      expect(await promptAndWait(session, "AGY_WORKSPACE_RESUME")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const resumed = env.raw.findLast((request) => !JSON.stringify(asRecord(request.body)?.systemInstruction).includes("conversation title generator"));
      const system = asRecordList(asRecord(asRecord(resumed?.body)?.systemInstruction)?.parts)
        .map(part => typeof part.text === "string" ? part.text : "").join("\n");
      const nativeCwd = /Command Working Directory: ([^\n]+)/u.exec(system)?.[1];
      assert.ok(nativeCwd !== undefined, "Native system instructions must report the command cwd");
      // macOS resolves /var to /private/var; Windows paths must not be JSON-escaped.
      expect(sameDirectory(nativeCwd, cwd)).toBe(true);
      await expect(antigravityRuntime.session(installation, { cwd, env: env.env, resume: "oar-missing-session" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "cwd" });
    } finally { await session?.dispose(); await env.stop(); }
  }, 60_000);
});
