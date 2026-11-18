import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { defaultRuntimes } from "../../packages/oar/src/index.js";
import type { SkillEntry } from "../../packages/oar/src/contracts/inventory.js";

async function skill(cwd: string, directory: string, frontmatter: string): Promise<void> {
  await mkdir(join(cwd, ".claude", "skills", directory), { recursive: true });
  await writeFile(join(cwd, ".claude", "skills", directory, "SKILL.md"), `---\n${frontmatter}\n---\nPRIVATE SKILL BODY\n`);
}

/** The skills join against the real binary: what Claude lists as a command decides `userInvocable`. */
test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude skills join context entries with their own commands only", async () => {
  const root = await mkdtemp(join(tmpdir(), "oar-claude-skills-"));
  const cwd = join(root, "project");
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await skill(cwd, "oar-runnable", "name: oar-runnable\ndescription: Runnable fixture");
    await skill(cwd, "oar-not-runnable", "name: oar-not-runnable\ndescription: Not runnable\nuser-invocable: false");
    await skill(cwd, "oar-model-hidden", "name: oar-model-hidden\ndescription: Model hidden\ndisable-model-invocation: true");
    // Two directories, one frontmatter name: only one of them is runnable.
    await skill(cwd, "oar-same-a", "name: oar-same\ndescription: Same A");
    await skill(cwd, "oar-same-b", "name: oar-same\ndescription: Same B\nuser-invocable: false");
    // A directory named differently from its skill: Claude lists the directory as the command's alias.
    await skill(cwd, "oar-other-dir", "name: oar-renamed\ndescription: Renamed fixture");
    // The visible sibling is not runnable; the runnable one is hidden from the model.
    await skill(cwd, "oar-pair-a", "name: oar-pair\ndescription: Pair A\nuser-invocable: false");
    await skill(cwd, "oar-pair-b", "name: oar-pair\ndescription: Pair B\ndisable-model-invocation: true");
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "config"));
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
    const runtime = defaultRuntimes.require("claude");
    const installation = await runtime.installation?.();
    assert.ok(installation?.kind === "available", JSON.stringify(installation));
    const result = await runtime.skills(installation, { cwd });
    assert.equal(result.kind, "ok", JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    const ours = result.items.filter((entry) => entry.name.startsWith("oar-"));
    const byName = (name: string): readonly SkillEntry[] => ours.filter((entry) => entry.name === name);
    const [runnable] = byName("oar-runnable");
    assert.equal(runnable?.userInvocable, true, JSON.stringify(ours));
    assert.equal(runnable.description, "Runnable fixture");
    assert.equal(runnable.scope, "project");
    assert.equal(byName("oar-not-runnable")[0]?.userInvocable, false, JSON.stringify(ours));
    const [hidden] = byName("oar-model-hidden");
    assert.equal(hidden?.userInvocable, true, JSON.stringify(ours));
    assert.equal(hidden.scope, "project");
    const [renamed] = byName("oar-renamed");
    assert.equal(renamed?.userInvocable, true, JSON.stringify(ours));
    assert.equal(renamed.description, "Renamed fixture");
    for (const entry of byName("oar-pair")) {
      assert.notEqual(entry.userInvocable, true, JSON.stringify(ours));
      assert.notEqual(entry.description, "Pair B", JSON.stringify(ours));
    }
    const same = byName("oar-same");
    assert.ok(same.length > 0, JSON.stringify(ours));
    for (const entry of same) {
      assert.equal(entry.userInvocable, undefined, JSON.stringify(same));
      assert.equal(entry.description, undefined, JSON.stringify(same));
    }
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}, 60_000);
