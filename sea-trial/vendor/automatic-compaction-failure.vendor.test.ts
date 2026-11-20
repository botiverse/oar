import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LLMock } from "@copilotkit/aimock";
import { expect, test } from "vitest";
import { claudeRuntime, opencodeRuntime, eventsOf, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startPiAimock } from "../harness/aimock.js";
import { startOpencodeAimock } from "../harness/aimock-acp.js";
import { semverAtLeast } from "../../packages/oar/src/shared/semver.js";
import { isPiBackend, piTestRuntime } from "./support/pi-runtime.js";

const claude = process.env.OAR_TEST === "claude-aimock";
const opencode = process.env.OAR_TEST === "opencode-aimock" ? await opencodeRuntime.installation() : undefined;
const opencodeV2 = opencode?.kind === "available" && opencode.via === "executable" && semverAtLeast(opencode.version, "2.2.7");
const overflow = "This model's maximum context length is 10000 tokens. However, your messages resulted in 18000 tokens. Please reduce the length of the messages.";
const answer = `The synthetic source contains only repeated text. ${"One fact. ".repeat(80)}`;

test.skipIf(!claude && !isPiBackend && !opencodeV2)("a failed automatic overflow compaction ends the turn and a later input can complete", async () => {
  let faultCalls = 0;
  let failing = false;
  const configure = (mock: LLMock): void => {
    mock.on({ predicate: () => true }, () => {
      if (!failing) { return { content: answer, usage: { input_tokens: 200, output_tokens: 25 } }; }
      faultCalls += 1;
      const first = faultCalls === 1;
      return { status: 400, error: { type: "invalid_request_error", code: first ? "context_length_exceeded" : "invalid_request_error", message: first ? overflow : "Controlled summary failure" } };
    });
  };
  const directory = await mkdtemp(path.join(tmpdir(), "oar-overflow-"));
  const cwd = await realpath(directory);
  const provider = opencodeV2 ? await startOpencodeAimock(configure) : (claude ? await startClaudeAimock(configure) : await startPiAimock(configure, { contextWindow: 10_000, settings: { compaction: { enabled: true, reserveTokens: 1500, keepRecentTokens: 500 } } }));
  let session: Session | undefined = undefined;
  try {
    const runtime = opencodeV2 ? opencodeRuntime : (claude ? claudeRuntime : piTestRuntime);
    const installation = await runtime.installation();
    if (installation.kind !== "available") { throw new Error("The selected vendor runtime is unavailable"); }
    session = await runtime.session(installation, { cwd, env: { ...provider.env, ...(claude ? { CLAUDE_CONFIG_DIR: cwd } : {}) }, ...(isPiBackend ? { model: "aimock/aimock-model" } : {}) });
    const completed = { kind: "ended", outcome: { kind: "completed" } };
    expect(await promptAndWait(session, "First source. ".repeat(100))).toMatchObject(completed);
    expect(await promptAndWait(session, "Second source. ".repeat(100))).toMatchObject(completed);
    const before = session.records().length;
    failing = true;
    expect(await promptAndWait(session, "Continue with these sources.", { timeoutMs: 45_000 })).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "input_too_large" } });
    const events = session.records().slice(before).flatMap(record => eventsOf(record));
    expect(events.filter(e => e.kind === "compaction_started" || e.kind === "compaction_ended")).toMatchObject([
      { kind: "compaction_started" }, { kind: "compaction_ended", outcome: "failed", ...(opencodeV2 ? { trigger: "auto" } : {}) },
    ]);
    if (!opencodeV2) {
      const failure = events.find(e => e.kind === "compaction_ended");
      expect(failure?.reason).toContain("Controlled summary failure");
    }
    expect(session.status().value.kind).toBe("idle");
    failing = false;
    expect(await promptAndWait(session, "Continue after the provider recovers.")).toMatchObject(completed);
  } finally {
    try { await session?.dispose(); } finally { await provider.stop(); await rm(cwd, { recursive: true, force: true }); }
  }
}, 90_000);
