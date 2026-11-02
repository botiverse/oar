import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, onTestFailed, test } from "vitest";
import { claudeRuntime, codexRuntime, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";
import { runTurn } from "./support/asserts.js";
import { newPrompts, oldPrompts, promptKeys, promptMarkers, promptSemantics, requestsForTurn, resumedMarker } from "./support/resumed-prompts.js";

async function fixture(backend: "claude" | "codex") {
  let largeUsage = false;
  const provider = await (backend === "claude" ? startClaudeAimock : startCodexAimock)((mock) => {
    mock.onMessage(/[\s\S]*/u, () => {
      const tokens = largeUsage ? 200_000 : 100;
      largeUsage = false;
      return { content: "A short response or conversation summary.", usage: { input_tokens: tokens, output_tokens: 10 } };
    });
  }, { captureRaw: true });
  let root: string | undefined = undefined;
  try {
    root = await mkdtemp(path.join(tmpdir(), "oar-resume-prompts-"));
    const cwd = path.join(root, "project");
    await mkdir(cwd);
    const runtime = backend === "claude" ? claudeRuntime : codexRuntime;
    const installation = await runtime.installation();
    assert.ok(installation.kind === "available", `installation: ${installation.kind}`);
    const env = { ...provider.env };
    if (backend === "claude") {
      env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
      await mkdir(env.CLAUDE_CONFIG_DIR);
    } else {
      assert.ok(env.CODEX_HOME !== undefined);
      const file = path.join(env.CODEX_HOME, "config.toml");
      await writeFile(file, `model_auto_compact_token_limit = 100000\n${await readFile(file, "utf8")}`);
    }
    const directory = root;
    return {
      runtime, raw: provider.raw,
      open: async (options: Partial<SessionOptions> = {}) => runtime.session(installation, { cwd, env, ...options }),
      compact: async (session: Session) => {
        if (backend === "claude") { expect(await runTurn(session, "/compact")).toEqual({ kind: "completed" }); }
        else {
          // Native usage drives the next turn's automatic compaction. No
          // adapter-only RPC or proposed compact() control is involved.
          largeUsage = true;
          expect(await runTurn(session, "OAR_RAISE_CONTEXT_USAGE")).toEqual({ kind: "completed" });
        }
      },
      stop: async () => { try { await provider.stop(); } finally { await rm(directory, { recursive: true, force: true }); } },
    };
  } catch (error) {
    await provider.stop();
    if (root !== undefined) { await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}

for (const backend of ["claude", "codex"] as const) {
  describe.skipIf(process.env.OAR_TEST !== `${backend}-aimock`)(`${backend} declared resumed prompts`, () => {
    test.each(promptKeys.flatMap((key) => [true, false].map((provided) => ({ key, provided }))))("$key provided=$provided agrees before and after native compaction", async ({ key, provided }) => {
      const f = await fixture(backend);
      const sessions: Session[] = [];
      onTestFailed(async () => {
        await mkdir("oar-trial-run/resume-prompts", { recursive: true });
        await writeFile(`oar-trial-run/resume-prompts/${backend}-${key}-${String(provided)}.json`, JSON.stringify({ provider: f.raw, records: sessions.map((session) => session.records()) }, null, 2));
      });
      try {
        const semantics = promptSemantics(f.runtime, key);
        const first = await f.open({ [key]: oldPrompts[key] });
        sessions.push(first);
        expect(await runTurn(first, "OAR_SEED_PROMPT_HISTORY")).toEqual({ kind: "completed" });
        expect(requestsForTurn(f.raw, "OAR_SEED_PROMPT_HISTORY").at(-1)?.system).toContain(oldPrompts[key]);
        await first.dispose();
        const resumed = await f.open({ resume: first.id, ...(provided ? { [key]: newPrompts[key] } : {}) });
        sessions.push(resumed);
        expect(resumed.id).toBe(first.id);
        for (const compacted of [false, true]) {
          if (compacted) { await f.compact(resumed); }
          const input = compacted ? "OAR_AFTER_NATIVE_COMPACT" : "OAR_BEFORE_NATIVE_COMPACT";
          const begin = f.raw.length;
          expect(await runTurn(resumed, input)).toEqual({ kind: "completed" });
          const requests = requestsForTurn(f.raw.slice(begin), input);
          expect(requests.length, "main turn needs fresh provider evidence").toBeGreaterThan(0);
          for (const { system, history } of requests) {
            if (!compacted) { expect(history).toContain("OAR_SEED_PROMPT_HISTORY"); }
            expect(system.length).toBeGreaterThan(50);
            expect(promptMarkers.filter((marker) => system.includes(marker))).toEqual(resumedMarker(semantics, { saved: oldPrompts[key], provided: provided ? newPrompts[key] : undefined }, compacted));
          }
        }
        const events = resumed.records().flatMap((record) => record.kind === "frame" ? record.body.events : []);
        expect(events.filter((event) => event.kind === "compaction_started")).toHaveLength(backend === "claude" ? 0 : 1);
        expect(events.filter((event) => event.kind === "compaction_ended")).toHaveLength(1);
      } finally {
        try { for (const session of sessions) { await session.dispose(); } } finally { await f.stop(); }
      }
    }, 120_000);
  });
}
