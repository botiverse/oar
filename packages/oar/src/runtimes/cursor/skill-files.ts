import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runExecutable } from "../../shared/executable/index.js";
import { environmentValue } from "../../shared/environment.js";
import { cursorNativeEnvironment } from "./native-environment.js";

// SDK 1.4.0 dist/esm/993.js: nf, Ef, af, Ia and NestedExtensibilityService.
export const SKILL_BRANDS = [".cursor", ".claude", ".codex", ".grok", ".agents"];
const DIRECT_SKIP = new Set(["node_modules", "__pycache__", "dist", "build"]);
const NESTED_SKIP = ["node_modules", ".git", ".turbo", ".next", ".cache", ".pnpm", ".yarn", "dist", "build", "out", "target", ".vscode", ".idea", "venv", "__pycache__", "logs", "tmp", "temp"];
const CODEX_SKIP = new Set(["imagegen", "openai-docs", "opneai-docs", "plugin-creator", "skill-creator", "skill-installer"]);
export interface SkillScan { partial: boolean; readonly signal: AbortSignal }

export function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
export function ignoredSkill(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  const root = parts.findIndex((part, index) => SKILL_BRANDS.includes(part) && ["skills", "skills-cursor"].includes(parts[index + 1] ?? ""));
  if (root !== -1 && parts.slice(root + 2).some(part => part.startsWith("."))) { return true; }
  const codex = parts.lastIndexOf(".codex");
  return codex !== -1 && parts[codex + 1] === "skills" && CODEX_SKIP.has(parts.at(-2) ?? "");
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Direct roots use the SDK's depth-limited walk, independent of ignore files. */
export async function directSkillFiles(root: string, scan: SkillScan): Promise<string[]> {
  const pending = [{ directory: root, depth: 0 }];
  const seen = new Set<string>();
  const files: string[] = [];
  while (pending.length > 0) {
    scan.signal.throwIfAborted();
    const entry = pending.pop();
    if (entry === undefined || entry.depth > 10) { continue; }
    try {
      const canonical = await realpath(entry.directory);
      if (seen.has(canonical)) { continue; }
      seen.add(canonical);
      for (const child of await readdir(entry.directory, { withFileTypes: true })) {
        scan.signal.throwIfAborted();
        const path = join(entry.directory, child.name);
        const info = child.isSymbolicLink() ? await stat(path).catch(() => null) : child;
        if (info?.isDirectory() === true && !child.name.startsWith(".") && !DIRECT_SKIP.has(child.name)) { pending.push({ directory: path, depth: entry.depth + 1 }); }
        if (info?.isFile() === true && child.name === "SKILL.md") { files.push(path); }
      }
    } catch (error) { if (!missing(error)) { scan.partial = true; } }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

function nestedAllowed(cwd: string, home: string): boolean {
  if (cwd === home) { return false; }
  if (process.platform !== "darwin") { return true; }
  const protectedRoots = ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", "Library", ".Trash"].map(part => join(home, part));
  return ![...protectedRoots, "/Volumes"].some(path => path !== cwd && within(cwd.toLowerCase(), path.toLowerCase()));
}

/** Reuse the SDK's actual ripgrep companion for its ignore-file semantics. */
export async function nestedSkillFiles(cwd: string, home: string, env: NodeJS.ProcessEnv, scan: SkillScan): Promise<string[]> {
  if (!nestedAllowed(cwd, home)) { return []; }
  const git = await runExecutable("git", ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"], { cwd, env, signal: scan.signal });
  if (!git.ok) { return []; }
  const rg = environmentValue(env, "CURSOR_RIPGREP_PATH") ?? cursorNativeEnvironment()?.CURSOR_RIPGREP_PATH;
  if (rg === undefined) { scan.partial = true; return []; }
  const args = ["--files", "--hidden", "--no-require-git", "--no-config", "--color=never", "--threads", "2", "--follow"];
  for (const brand of SKILL_BRANDS) { args.push("--iglob", `*/**/${brand}/**`); }
  for (const name of NESTED_SKIP) { args.push("--iglob", `!**/${name}/**`); }
  const result = await runExecutable(rg, args, { cwd, env, signal: scan.signal });
  if (result.stdout.length >= 2 * 1024 * 1024 || (!result.ok && result.exitCode !== 1)) { scan.partial = true; }
  return result.stdout.split(/\r?\n/u).filter(path => /[/\\]\.(?:cursor[/\\]skills(?:-cursor)?|(?:claude|codex|grok|agents)[/\\]skills)[/\\](?:.*[/\\])?SKILL\.md$/iu.test(path)).map(path => resolve(cwd, path));
}
