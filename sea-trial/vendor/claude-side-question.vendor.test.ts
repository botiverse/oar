import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { claudeRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { hookMarks, sessionStartHook } from "./support/session-start-hook.js";

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("answers once from a running or stopped source without saving or invoking a user hook", async () => {
  const installation = await claudeRuntime.installation();
  if (installation.kind !== "available") { throw new Error("Claude fixture unavailable"); }
  expect(claudeRuntime.sessionCapabilities(installation).sideQuestion).toBe(true);
  const root = await mkdtemp(path.join(tmpdir(), "oar-claude-side-question-"));
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await startClaudeAimock(mock => {
    mock.onMessage("hold this turn", async () => { held.resolve(); await release.promise; return { content: "source completed" }; });
    mock.onMessage(/[\s\S]*/u, { content: "one answer" });
  }, { captureRaw: true });
  try {
    const hook = sessionStartHook(root, 0);
    await writeFile(path.join(root, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook.command }] }] } }));
    const options = { cwd: root, env: { ...fixture.env, HOME: root, CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_AUTH_TOKEN: null }, model: "sonnet" };
    const source = await claudeRuntime.session(installation, options);
    const transcripts = async (): Promise<string[]> => {
      const paths = await readdir(path.join(root, "projects"), { recursive: true });
      return paths.filter(file => file.endsWith(".jsonl")).toSorted();
    };
    const ask = async (question: string): Promise<void> => {
      const files = await transcripts();
      const native = files.find(file => path.basename(file) === `${source.id}.jsonl`);
      if (native === undefined) { throw new Error("fixture source has no saved conversation"); }
      const file = path.join(root, "projects", native);
      const before = await readFile(file);
      const marks = await hookMarks(hook.file);
      expect(marks.length).toBeGreaterThan(0);
      const answer = await claudeRuntime.sideQuestion(installation, { ...options, question, sessionId: source.id });
      expect(answer).toBe("one answer");
      const wire = fixture.raw.findLast(request => JSON.stringify(request.body).includes(question))?.body;
      expect(wire).toMatchObject({ tools: [] });
      expect(JSON.stringify(wire)).toContain("saved source history");
      expect(await hookMarks(hook.file)).toEqual(marks);
      expect(await transcripts()).toEqual(files);
      const after = await readFile(file);
      expect(after.includes(question)).toBe(false);
      if (source.status().value.kind === "running") { expect(after.subarray(0, before.length)).toEqual(before); }
      else { expect(after).toEqual(before); }
    };
    try {
      const seed = await promptAndWait(source, "saved source history", { timeoutMs: 30_000 });
      expect(seed.kind).toBe("ended");
      const turn = promptAndWait(source, "hold this turn", { timeoutMs: 90_000 });
      try {
        await Promise.race([held.promise, turn.then(() => { throw new Error("source ended before the provider held its turn"); })]);
        await ask("question for the active source");
        expect(source.status().value.kind).toBe("running");
      } finally { release.resolve(); }
      const settled = await turn;
      expect(settled.kind).toBe("ended");
    } finally { await source.dispose(); }
    await ask("question for the stopped source");

    await expect(claudeRuntime.sideQuestion(installation, { ...options, sessionId: randomUUID(), question: "missing source" })).rejects.toThrow("successful side answer");
    expect(fixture.raw.some(request => JSON.stringify(request.body).includes("missing source"))).toBe(false);
  } finally {
    release.resolve();
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);
