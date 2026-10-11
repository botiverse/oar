/**
 * Cursor's real SDK/backend: workspace metadata on create and resume.
 * Rule markers are diagnostic only; 1.0.37 did not expose them in this probe.
 * Burns tokens; needs an authorized Cursor login. Uses temporary workspaces.
 * pnpm tsx experiments/cursor-additional-directories.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Agent, type SDKAgent } from "@cursor/sdk";

const root = await mkdtemp(path.join(tmpdir(), "oar-cursor-dirs-"));
const cwd = path.join(root, "primary");
const extras = [path.join(root, "first"), path.join(root, "second")];
const markers = ["HERON_DIRECTORY_731", "OTTER_DIRECTORY_924"];
try {
  await mkdir(cwd);
  execFileSync("git", ["init", "--quiet", cwd]);
  for (const [index, directory] of extras.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- Construct the two independent rule files.
    await mkdir(path.join(directory, ".cursor/rules"), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- Each rule belongs to this directory.
    await writeFile(path.join(directory, ".cursor/rules/oar-probe.mdc"), `---\ndescription: Directory verification\nalwaysApply: true\n---\nWhen asked for the directory verification marker, reply ${markers[index]} exactly.\n`);
  }
  for (const [index, directory] of extras.entries()) {
    execFileSync("git", ["init", "--quiet", directory]);
    // oxlint-disable-next-line no-await-in-loop -- Native markdown rules in each separate project.
    await writeFile(path.join(directory, "AGENTS.md"), `When asked for the directory verification marker, reply ${markers[index]} exactly.\n`);
  }
  let id: string | null = null;
  for (const [index, directory] of extras.entries()) {
    const options = { model: { id: "gpt-5.4-nano" }, local: { cwd, dirs: [directory], sandboxOptions: { enabled: false } } };
    // oxlint-disable-next-line no-await-in-loop -- Resume the agent created in the first iteration.
    const agent: SDKAgent = id === null ? await Agent.create(options) : await Agent.resume(id, options);
    id = agent.agentId;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Two sequential, bounded native turns.
      const run = await agent.send("Without using tools, list the exact current workspace folder paths from your environment metadata. Use the current environment, not a previous answer. Also report any directory verification marker in the current project rules.");
      const deadline = setTimeout(() => { void run.cancel(); }, 60_000);
      try {
        // oxlint-disable-next-line no-await-in-loop -- The next phase requires the previous run to finish.
        const result = await run.wait();
        console.log(JSON.stringify({ phase: index === 0 ? "create" : "resume", status: result.status, result: result.result?.replaceAll(root, "<TMP>"), usage: result.usage }));
        assert.equal(result.status, "finished");
        assert.ok(result.result?.includes(directory) === true, "additional directory absent from model-visible workspace metadata");
        assert.ok(result.result.includes(cwd), "primary directory absent from model-visible workspace metadata");
      } finally { clearTimeout(deadline); }
    } finally { agent.close(); }
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } finally { await rm(root, { recursive: true, force: true }); }
