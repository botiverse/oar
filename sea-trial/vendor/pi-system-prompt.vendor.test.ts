import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { isPiBackend, piSession, piChildCwd } from "./support/pi-runtime.js";
import { startPiAimock } from "../harness/aimock.js";
import { runTurn } from "./support/asserts.js";
import { APPEND_MARKER, REPLACE_MARKER, lastAgentSystem, scrubSystem, systemCapture } from "./support/system-prompt.js";

/**
 * SessionOptions.systemPrompt replaces pi's base prompt TEXT, not the whole
 * system prompt: pi 0.87.1 (core/system-prompt.js) keeps its runtime-native
 * additions around the replaced prompt: the append seam, project context
 * files, the skills catalog, the cwd line. The skills catalog lists the
 * HOST's ~/.agents/skills (package-manager.js loadSkills), present or absent
 * per machine, so that block is cut before the snapshot; the cwd line stays
 * (masked by scrubSystem). The seam is documented in docs/runtimes/pi.md;
 * `noSkills` was not taken, since it drops every skill (project ones too).
 */
function withoutHostSkills(system: string): string {
  return system.replace(/\n+<skills>[\s\S]*?<\/skills>/u, "");
}

describe.skipIf(!isPiBackend)("Pi system prompt boundary", () => {
  test("system prompt replace+append land and SURVIVE threshold auto-compaction, and compaction is in the stream", async () => {
    // The deterministic auto-compaction recipe: tiny context window in the
    // model definition + fat reported usage + compaction settings.
    const capture = systemCapture({
      content: `padding. ${"the quick brown fox jumps over the lazy dog. ".repeat(120)}`,
      usage: { input_tokens: 9000, output_tokens: 400 },
    });
    const env = await startPiAimock((mock) => { capture.configure(mock); }, {
      contextWindow: 10_000,
      settings: { compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 500 } },
    });
    // Native ancestor context is preserved even with systemPrompt replacement.
    // Keep this exact prompt snapshot independent of the checkout's parents.
    // Runners can put TMPDIR/TMP/TEMP inside a checkout with ancestor AGENTS
    // or CLAUDE files. Ask Node for the OS default without those overrides;
    // both the in-process SDK and RPC use this same context-free directory.
    const inherited = await mkdtemp(path.join(tmpdir(), "oar-pi-ancestor-"));
    await writeFile(path.join(inherited, "CLAUDE.md"), "OAR-ANCESTOR-CONTEXT-CONTROL");
    const configuredTemp = path.join(inherited, ".raft", "agents", "tmp");
    await mkdir(configuredTemp, { recursive: true });
    for (const key of ["TMPDIR", "TMP", "TEMP"]) { vi.stubEnv(key, configuredTemp); }
    const { TMPDIR: _tmpdir, TMP: _tmp, TEMP: _temp, ...environment } = process.env;
    const nativeTemp = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').tmpdir())"], { env: environment, encoding: "utf8" });
    // Canonicalize once so SDK input and RPC process.cwd() agree on macOS.
    const cwd = await realpath(await mkdtemp(path.join(nativeTemp, "oar-pi-system-")));
    let session: Awaited<ReturnType<typeof piSession>> | undefined = undefined;
    try {
      session = await piSession({ kind: "available", via: "bundled" }, {
        cwd, model: "aimock/aimock-model",
        systemPrompt: `${REPLACE_MARKER} you are the oar probe agent`,
        appendSystemPrompt: `${APPEND_MARKER} always be brief`,
      });
      for (const input of ["topic one", "topic two", "topic three"]) {
        await runTurn(session, input);
      }
      // Threshold compaction fired during those turns (recipe pinned in the
      // compaction probes); the latest provider request (the compaction
      // summarization or the post-compaction turn) must still carry both
      // markers and none of pi's own base prompt.
      const system = withoutHostSkills(scrubSystem(lastAgentSystem(capture.systems), piChildCwd(cwd)));
      expect(system).toMatchInlineSnapshot(`
        "OAR-SYSTEM-REPLACE-MARKER you are the oar probe agent

        <addendum>
        OAR-SYSTEM-APPEND-MARKER always be brief
        </addendum>

        <cwd>
        <CWD>
        </cwd>"
      `);
      // pi's session-scoped compaction events are not dropped: they enter the
      // stream verbatim, with no view.
      const compactionTypes = session.records()
        .flatMap((record) => (record.kind === "frame" && record.body.type.startsWith("compaction_") ? [record.body.type] : []));
      expect(compactionTypes).toContain("compaction_start");
      expect(compactionTypes).toContain("compaction_end");
    } finally {
      await session?.dispose();
      await env.stop();
      vi.unstubAllEnvs();
      await rm(inherited, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }, 120_000);

});
