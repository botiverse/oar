/* oxlint-disable import/prefer-default-export -- Shared fixture for the native catalog comparison. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Fixture {
  readonly root: string; readonly cwd: string; readonly home: string;
  readonly config: string; readonly configText: string; readonly env: NodeJS.ProcessEnv;
}
export async function devinSkillsFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "oar-devin-skills-"));
  const cwd = join(root, "project"); const home = join(root, "home");
  const config = join(home, "config", "devin", "config.json");
  await Promise.all([mkdir(cwd), mkdir(dirname(config), { recursive: true })]);
  const configText = '{"version":1,"auto_update":false}\n';
  await writeFile(config, configText);
  // A fresh environment contains no real account and directs native HTTP attempts to a closed loopback port.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), APPDATA: join(home, "config"), LOCALAPPDATA: join(home, "localappdata"), CI: "1", NO_COLOR: "1", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "" };
  return { root, cwd, home, config, configText, env };
}

export async function populateDevinSkills(f: Awaited<ReturnType<typeof devinSkillsFixture>>): Promise<void> {
  const roots = [
    [f.home, "config/devin/skills", "user-devin"], [f.home, ".agents/skills", "user-agents"],
    [f.home, ".claude/skills", "user-claude"], [f.home, ".codeium/windsurf/skills", "user-windsurf"],
    [f.cwd, ".devin/skills", "project-devin"], [f.cwd, ".agents/skills", "project-agents"],
    [f.cwd, ".claude/skills", "project-claude"], [f.cwd, ".windsurf/skills", "project-windsurf"],
  ] as const;
  await Promise.all(roots.map(async ([base, path, name]) => {
    await writeSkill(join(base, path, name), `name: ${name}\ndescription: Synthetic ${name} metadata\ntriggers: [user]`);
  }));
  await writeSkill(join(f.cwd, ".devin/skills/model-only"), "name: model-only\ndescription: Model-only fixture\ntriggers: [model]");
  await writeSkill(join(f.cwd, ".devin/skills/broken-yaml"), "name: [invalid");
}

async function writeSkill(dir: string, metadata: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${metadata}\n---\nPRIVATE SKILL BODY\n!\`touch OAR_SKILL_BODY_EXECUTED\`\n`);
}
