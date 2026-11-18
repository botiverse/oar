import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DshFixture } from "./dsh-fixture.js";

/** Native fixtures own a Git root so discovery cannot select an ancestor repository. */
export async function populateDshSkills(f: DshFixture): Promise<Readonly<Record<string, string>>> {
  const cwd = f.aimock.cwd;
  const agents = path.join(f.aimock.home, "fixture-agents");
  const bundled = path.join(f.aimock.home, "fixture-bundled");
  await mkdir(path.join(cwd, ".git"));
  const roots = [
    ["project-dsh", path.join(cwd, ".dsh", "skills")], ["project-agents", path.join(cwd, ".agents", "skills")],
    ["user-dsh", path.join(f.aimock.home, "skills")], ["user-agents", path.join(agents, "skills")], ["bundled-fixture", bundled],
  ];
  await Promise.all(roots.map(async ([name, root]) => {
    const directory = path.join(String(root), String(name));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${String(name)}\ndescription: ${String(name)} fixture\ndisable-model-invocation: true\n---\nPRIVATE SKILL BODY\n`);
  }));
  const hidden = path.join(cwd, ".dsh", "skills", "hidden-fixture");
  await mkdir(hidden, { recursive: true });
  await writeFile(path.join(hidden, "SKILL.md"), "---\nname: hidden-fixture\ndescription: Hidden fixture\nuser-invocable: false\n---\nPRIVATE SKILL BODY\n");
  await writeFile(path.join(f.aimock.home, "skills", "malformed.md"), "---\nname: [invalid\n---\nPRIVATE BAD BODY\n");
  return { ...f.aimock.env, DSH_AGENTS_HOME: agents, DSH_BUNDLED_SKILL_DIR: bundled };
}

/** A native provider failure is a partial catalog; a provider that never settles tests the owner deadline. */
export async function dshSkillProvider(f: DshFixture, mode: "failure" | "hang"): Promise<readonly unknown[]> {
  const plugin = path.join(f.aimock.home, `skill-provider-${mode}.mjs`);
  await writeFile(plugin, `import { writeFileSync } from "node:fs";
export const name = "fixture-skill-provider";
export const inject = ["skills"];
export function apply(ctx) { ctx.skills.registerProvider(() => ({ name: "fixture-${mode}",
list: async () => { writeFileSync(${JSON.stringify(path.join(f.aimock.home, "provider-entered"))}, String(process.pid)); ${mode === "failure" ? 'throw new Error("PRIVATE_PROVIDER_ERROR");' : 'await new Promise(() => {}); return [];'} },
get: async () => undefined })); }
`);
  return [{ insert: [{ id: "fixture-skill-provider", name: pathToFileURL(plugin).href }] }];
}
