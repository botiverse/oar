import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createCursorRuntime } from "../../packages/oar/src/runtimes/cursor/index.js";
import { cursorSkillsFixture } from "../fixtures/cursor-skills.js";

const installation = { kind: "available", via: "bundled" } as const;
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true }))); });

// oxlint-disable-next-line max-statements -- Assert the native discovery boundary in one fixture.
test("Cursor exposes measured skill discovery without loading the SDK", async () => {
  const f = await cursorSkillsFixture(); roots.push(f.root);
  vi.stubEnv("HOME", f.home); vi.stubEnv("USERPROFILE", f.home);
  const load = vi.fn(async () => { throw new Error("No SDK load expected"); });
  const result = await createCursorRuntime({ sdk: load }).skills(installation, { cwd: f.cwd });
  expect(load).not.toHaveBeenCalled();
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") { return; }
  expect(result.view).toBe("discovered"); expect(result.partial).toBe(true);
  expect(result.items.find(item => item.name === "folder-name")).toEqual({ name: "folder-name", path: join(f.cwd, ".cursor", "skills", "folder-name", "SKILL.md"), description: "metadata description", disableModelInvocation: false, source: "workspace", scope: "project" });
  expect(result.items.filter(item => item.name === "duplicate").map(item => item.description)).toEqual(["cursor duplicate"]);
  expect(result.items.filter(item => item.scope === "user")).toHaveLength(5);
  expect(result.items.some(item => ["always", "ide-only", "invalid", "missing-description", "outside", "alias", "builtin", "managed", "nested-cursor", "dependency", "deep"].includes(item.name))).toBe(false);
  expect(result.items.find(item => item.name === "disabled")).toMatchObject({ description: "", disableModelInvocation: true });
  expect(JSON.stringify(result)).not.toContain("PRIVATE SKILL BODY");
});

test("Cursor in-process readers reject env but subprocess discovery uses its clean overlay", async () => {
  const f = await cursorSkillsFixture(); roots.push(f.root);
  const runtime = createCursorRuntime({ sdk: async () => { throw new Error("No SDK load"); } });
  await expect(runtime.skills(installation, { cwd: f.cwd, env: { HOME: f.home } })).rejects.toThrow();
  const isolated = createCursorRuntime({ execution: "subprocess", sdkModule: "unloaded-sdk", envBase: "clean" });
  const result = await isolated.skills(installation, { cwd: f.cwd, env: { HOME: f.home, USERPROFILE: f.home } });
  expect(result).toMatchObject({ kind: "ok", view: "discovered" });
  if (result.kind === "ok") { expect(result.items.filter(item => item.scope === "user")).toHaveLength(5); }
});

// oxlint-disable-next-line max-statements -- Observe parser execution and completeness on the same isolated roots.
test("empty roots are complete, unreadable metadata is partial, and script frontmatter never executes", async () => {
  const f = await cursorSkillsFixture(); roots.push(f.root);
  await rm(f.cwd, { recursive: true }); await rm(f.home, { recursive: true });
  const runtime = createCursorRuntime({ execution: "subprocess", sdkModule: "unloaded-sdk", envBase: "clean" });
  const options = { cwd: f.cwd, env: { HOME: f.home, USERPROFILE: f.home } };
  expect(await runtime.skills(installation, options)).toMatchObject({ kind: "ok", partial: false, items: [] });
  const file = join(f.cwd, ".cursor", "skills", "script", "SKILL.md");
  await f.write(f.cwd, ".cursor/skills/script", "description: placeholder");
  vi.stubEnv("OAR_CURSOR_SCRIPT_RAN", undefined);
  await writeFile(file, '---js\n({ description: (process.env.OAR_CURSOR_SCRIPT_RAN = "yes") })\n---\nBody\n');
  expect(await runtime.skills(installation, options)).toMatchObject({ kind: "ok", partial: true, items: [] });
  expect(process.env.OAR_CURSOR_SCRIPT_RAN).toBeUndefined();
});

test("a failed nested scanner preserves direct discoveries and reports partial", async () => {
  const f = await cursorSkillsFixture(true); roots.push(f.root);
  // Leave no malformed metadata: only the unavailable nested scanner can set partial.
  await Promise.all(["invalid", "invalid-duplicate", "missing-description"].map(async name => rm(join(f.cwd, ".cursor", "skills", name), { recursive: true })));
  const runtime = createCursorRuntime({ execution: "subprocess", sdkModule: "unloaded-sdk", envBase: "clean" });
  const env = Object.fromEntries(Object.entries(f.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const result = await runtime.skills(installation, { cwd: f.cwd, env: { ...env, CURSOR_RIPGREP_PATH: join(f.root, "missing-rg") } });
  expect(result).toMatchObject({ kind: "ok", partial: true });
  if (result.kind === "ok") {
    expect(result.items.some(item => item.name === "project-cursor")).toBe(true);
    expect(result.items.some(item => item.name === "nested-cursor")).toBe(false);
  }
});
