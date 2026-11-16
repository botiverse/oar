/** Read native Claude/Grok catalogs without a prompt; optional existing-home Grok cache. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { claudeSkills } from "../packages/oar/src/runtimes/claude/inventory.js";
import { grokSkills } from "../packages/oar/src/runtimes/grok/inventory.js";

const [claude, grok, output] = process.argv.slice(2);
if (claude === undefined || grok === undefined || output === undefined) {
  throw new Error("Usage: tsx experiments/skills-builtins.ts <claude> <grok> <output.json>");
}
const directory = await mkdtemp(join(tmpdir(), "oar-skills-builtins-"));
try {
  const cwd = join(directory, "project");
  const home = join(directory, "home");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(home);
  const env = Object.fromEntries(Object.keys(process.env).filter((key) => !["PATH", "SystemRoot", "TEMP", "TMP"].includes(key)).map((key) => [key, null]));
  const options = { cwd, timeoutMs: 30_000, env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"), NO_COLOR: "1" } };
  const before = {
    claude: await claudeSkills({ kind: "available", via: "executable", command: resolve(claude) }, options),
    grok: await grokSkills({ kind: "available", via: "executable", command: resolve(grok) }, options),
  };
  await Promise.all([".agents", ".claude", ".grok"].map(async (brand) => {
    const fixture = join(cwd, brand, "skills", `oar-${brand.slice(1)}`);
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "SKILL.md"), `---\nname: oar-${brand.slice(1)}\ndescription: Native inventory control\n---\nDo not invoke.\n`);
  }));
  const after = {
    claude: await claudeSkills({ kind: "available", via: "executable", command: resolve(claude) }, options),
    grok: await grokSkills({ kind: "available", via: "executable", command: resolve(grok) }, options),
  };
  const existingGrok = process.env.OAR_SKILLS_EXISTING_GROK === "1"
    ? await grokSkills({ kind: "available", via: "executable", command: resolve(grok) }, { cwd, timeoutMs: 30_000 })
    : undefined;
  const result = { before, after, existingGrok };
  const serialized = `${JSON.stringify(result, null, 2).replaceAll(directory, "<fixture>")}\n`;
  await writeFile(output, serialized);
  process.stdout.write(serialized);
} finally {
  await rm(directory, { recursive: true, force: true });
}
