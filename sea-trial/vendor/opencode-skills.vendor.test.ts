/* oxlint-disable import/no-namespace -- Observe the real process while retaining native behavior. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
import * as executable from "../../packages/oar/src/shared/executable/index.js";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oar-opencode-skills-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const config = join(root, "config");
  await Promise.all([mkdir(join(cwd, ".git"), { recursive: true }), mkdir(home), mkdir(config)]);
  const roots = {
    "home-claude": join(home, ".claude", "skills"), "home-agents": join(home, ".agents", "skills"),
    "project-claude": join(cwd, ".claude", "skills"), "project-agents": join(cwd, ".agents", "skills"),
    "project-opencode": join(cwd, ".opencode", "skills"), "config-opencode": join(config, "opencode", "skills"),
  };
  for (const [name, path] of Object.entries(roots)) {
    await mkdir(join(path, name), { recursive: true });
    await writeFile(join(path, name, "SKILL.md"), `---\nname: ${name}\ndescription: Native fixture ${name}\n---\nPRIVATE SKILL BODY\n`);
  }
  const malformed = join(roots["project-opencode"], "malformed");
  await mkdir(malformed);
  await writeFile(join(malformed, "SKILL.md"), "---\nname: [bad\n---\nBad fixture\n");
  const stripped = Object.fromEntries(Object.keys(process.env).filter(key => !["PATH", "SystemRoot", "TEMP", "TMP"].includes(key)).map(key => [key, null]));
  return { root, cwd, roots, env: { ...stripped, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", NO_COLOR: "1" } };
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => { resolve(false); });
  });
}

const enabled = ["opencode-skills", "opencode-aimock", "opencode-cleanup"].includes(process.env.OAR_TEST ?? "");
describe.skipIf(!enabled)("OpenCode native skill discovery", () => {
  test.for(["success", "failure", "timeout", "plugin-failure"])("%s preserves native paths and reclaims the owned process", { timeout: 60_000 }, async (mode, context) => {
    const f = await fixture();
    const children: executable.LineProcess[] = [];
    const ports: number[] = [];
    const spawn = executable.spawnLineProcess;
    const command = process.env.OAR_OPENCODE_BIN === undefined ? "opencode" : resolvePath(process.env.OAR_OPENCODE_BIN);
    try {
      const version = await executable.runExecutable(command, ["--version"], { cwd: f.cwd, env: sessionEnvironment(f.env) });
      assert.ok(version.ok);
      const major = /^(?:opencode\s+)?v?2\./u.test(version.stdout.trim()) ? 2 : 1;
      // v1 has no HTTP service; malformed payload/exit and timeout are covered at its process boundary in unit tests.
      if (major === 1 && mode !== "success") { context.skip("v1 has no HTTP service"); }
      if (mode === "plugin-failure") {
        const plugins = join(f.cwd, ".opencode", "plugins");
        await mkdir(plugins, { recursive: true });
        await writeFile(join(plugins, "oar-broken.ts"), 'throw new Error("PRIVATE PLUGIN FAILURE");\nexport default {};\n');
      }
      vi.spyOn(executable, "spawnLineProcess").mockImplementation((...args) => {
        const child = spawn(...args); children.push(child);
        child.onLine(line => { const match = /^server listening on http:\/\/127\.0\.0\.1:([0-9]+)/u.exec(line); if (match?.[1] !== undefined) { ports.push(Number(match[1])); } });
        return child;
      });
      if (mode === "failure") { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Synthetic transport failure")); }
      if (mode === "timeout") {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { reject(new Error("Deadline")); }, { once: true });
        }));
      }
      const result = await opencodeRuntime.skills({ kind: "available", via: "executable", command, version: version.stdout.trim() }, { cwd: f.cwd, env: f.env, timeoutMs: mode === "timeout" ? 15_000 : 30_000 });
      if (mode === "success" || mode === "plugin-failure") {
        assert.equal(result.kind, "ok", JSON.stringify(result));
        expect(result.partial).toBe(mode === "plugin-failure"); expect(result.view).toBe("discovered");
        for (const [name, path] of Object.entries(f.roots)) { expect(result.items).toContainEqual(expect.objectContaining({ name, path: join(path, name, "SKILL.md") })); }
        expect(result.items.some(skill => skill.name === "malformed")).toBe(false);
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE SKILL BODY|PRIVATE PLUGIN FAILURE/u);
        expect(await readFile(join(f.roots["home-claude"], "home-claude", "SKILL.md"), "utf8")).toContain("PRIVATE SKILL BODY");
      } else { expect(result).toMatchObject({ kind: "unavailable", code: mode === "timeout" ? "timeout" : "query_failed" }); }
      expect(children).toHaveLength(1);
      for (const child of children) { assert.ok(child.pid !== undefined); expect(() => process.kill(child.pid ?? 0, 0)).toThrow(); }
      if (major === 2) { expect(ports).toHaveLength(1); for (const port of ports) { expect(await portOpen(port)).toBe(false); } }
      const dir = resolvePath(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "opencode-skills");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${major}-${mode}.json`), JSON.stringify({ version: version.stdout.trim(), mode, result, processesExited: true, portsClosed: true }, null, 2));
    } finally {
      vi.restoreAllMocks();
      for (const child of children) { child.kill(); await child.exited; }
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
