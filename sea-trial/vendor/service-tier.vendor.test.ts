import { asRecord } from "../../packages/oar/src/shared/json.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { defineRuntime, codexInstallation, codexSession, claudeInstallation, claudeSession } from "../../packages/oar/src/index.js";
import { startCodexAimock, startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex native service tier", () => {
  test("open and resume set every provider request's tier, including explicit default", async () => {
    const env = await startCodexAimock(undefined, { captureRaw: true });
    const subject = runtimeUnderTest(defineRuntime({ id: "codex-aimock", installation: codexInstallation, session: codexSession }), env.env);
    try {
      const fresh = await subject.startSession({ model: "gpt-5.5", effort: "low", serviceTier: "priority" });
      try {
        expect(fresh.serviceTier().value).toBe("priority");
        await runTurn(fresh, "hello priority");
      } finally { await fresh.dispose(); }
      const inherited = await subject.startSession({ resume: fresh.id });
      try {
        expect(inherited.serviceTier().value).toBe("default");
        await runTurn(inherited, "hello inherited");
      } finally { await inherited.dispose(); }
      const resumed = await subject.startSession({ resume: fresh.id, effort: "high", serviceTier: "flex" });
      try {
        expect(resumed.serviceTier().value).toBe("flex");
        expect(resumed.effort().value).toBe("high");
        await runTurn(resumed, "hello flex");
      } finally { await resumed.dispose(); }
      const home = env.env?.CODEX_HOME;
      if (home === undefined) { throw new Error("scripted codex home missing"); }
      const config = path.join(home, "config.toml");
      await writeFile(config, `service_tier = "priority"\n${await readFile(config, "utf8")}`);
      const configured = await subject.startSession({ resume: fresh.id });
      try {
        expect(configured.serviceTier().value).toBe("priority");
        await runTurn(configured, "hello configured tier");
      } finally { await configured.dispose(); }
      const standard = await subject.startSession({ resume: fresh.id, serviceTier: "default" });
      try {
        expect(standard.serviceTier().value).toBe("default");
        await runTurn(standard, "hello default");
      } finally { await standard.dispose(); }
      expect(env.raw.map((request) => asRecord(request.body)).filter((body) => Array.isArray(body?.input)).map((body) => body?.service_tier)).toEqual(["priority", undefined, "flex", "priority", undefined]);
      await expect(subject.startSession({ model: "gpt-5.5", serviceTier: "fast" })).rejects.toThrow(/priority.*fast/u);
      await expect(subject.startSession({ model: "gpt-5.5", serviceTier: "bogus" })).rejects.toThrow(/serviceTier .*bogus/u);
    } finally { await env.stop(); }
  }, 180_000);
});

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude native service tier", () => {
  test("per-session fast mode is read back before a turn and reaches Messages", async () => {
    const env = await startClaudeAimock(undefined, { captureRaw: true });
    const configDir = await mkdtemp(path.join(tmpdir(), "oar-claude-tier-"));
    const subject = runtimeUnderTest(defineRuntime({ id: "claude-aimock", installation: claudeInstallation, session: claudeSession }), { ...env.env, CLAUDE_CONFIG_DIR: configDir });
    try {
      const fresh = await subject.startSession({ model: "opus", effort: "low", serviceTier: "fast" });
      try {
        expect(fresh.serviceTier().value).toBeNull();
        await runTurn(fresh, "hello fast");
        expect(fresh.serviceTier().value).toBe("fast");
      } finally { await fresh.dispose(); }
      const resumed = await subject.startSession({ resume: fresh.id, model: "opus", serviceTier: "default" });
      try {
        expect(resumed.serviceTier().value).toBeNull();
        await runTurn(resumed, "hello default");
        expect(resumed.serviceTier().value).toBe("default");
      } finally { await resumed.dispose(); }
      const fastAgain = await subject.startSession({ resume: fresh.id, model: "opus", serviceTier: "fast" });
      try {
        expect(fastAgain.serviceTier().value).toBeNull();
        await runTurn(fastAgain, "hello fast again");
        expect(fastAgain.serviceTier().value).toBe("fast");
      } finally { await fastAgain.dispose(); }
      expect(env.raw.map((request) => asRecord(request.body)).filter((body) => Array.isArray(body?.messages)).map((body) => body?.speed)).toEqual(["fast", undefined, "fast"]);
      expect(env.raw.map((request) => asRecord(request.body)).find((body) => Array.isArray(body?.messages))?.output_config).toMatchObject({ effort: "low" });
      await expect(subject.startSession({ model: "sonnet", serviceTier: "fast" })).rejects.toThrow(/off.*fast/u);
    } finally { await env.stop(); await rm(configDir, { recursive: true, force: true }); }
  }, 180_000);
});
