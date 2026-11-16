import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oar-kimi-skills-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const data = join(root, "data");
  await Promise.all([mkdir(join(cwd, ".git"), { recursive: true }), mkdir(home), mkdir(data)]);
  const skill = join(cwd, ".agents", "skills", "oar-inventory");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: oar-inventory\ndescription: Native inventory fixture\n---\nNo invocation needed.\n");
  const config = "builtin_product_skills = true\n";
  await writeFile(join(data, "config.toml"), config);
  const trace = join(root, "processes.jsonl");
  const preload = join(root, "observe.cjs");
  await writeFile(preload, `const fs = require('node:fs');
fs.appendFileSync(process.env.OAR_SKILL_TRACE, JSON.stringify({pid: process.pid})+'\\n');
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = function(chunk, ...rest) {
  const m = /http:\\/\\/127\\.0\\.0\\.1:([0-9]+)/.exec(String(chunk));
  if (m) fs.appendFileSync(process.env.OAR_SKILL_TRACE, JSON.stringify({port: Number(m[1])})+'\\n');
  return write(chunk, ...rest);
};
`);
  const stripped = Object.fromEntries(Object.keys(process.env).filter((key) => !["PATH", "SystemRoot", "TEMP", "TMP"].includes(key)).map((key) => [key, null]));
  return { root, cwd, data, config, trace, env: { ...stripped, HOME: home, USERPROFILE: home, KIMI_CODE_HOME: data, NO_COLOR: "1", NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, OAR_SKILL_TRACE: trace } };
}

async function assertStopped(trace: string) {
  const text = await readFile(trace, "utf8");
  const entries = text.trim().split("\n").map((line) => {
    const entry = asRecord(parseJson(line));
    assert.ok(entry !== null);
    return { pid: typeof entry.pid === "number" ? entry.pid : undefined, port: typeof entry.port === "number" ? entry.port : undefined };
  });
  const ports = entries.flatMap((entry) => entry.port === undefined ? [] : [entry.port]);
  expect(ports.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const pid = entry.pid;
    if (pid !== undefined) { expect(() => process.kill(pid, 0)).toThrow(); }
  }
  for (const port of ports) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => { resolve(false); });
    });
    expect(reachable).toBe(false);
  }
}

describe.skipIf(!["kimi-skills", "kimi-login"].includes(process.env.OAR_TEST ?? ""))("Kimi native Web skill inventory", () => {
  test.each(["success", "failure", "timeout"])("%s shuts down its service and loopback listener", async (mode) => {
    const f = await fixture();
    try {
      if (mode === "failure") { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Synthetic transport failure")); }
      if (mode === "timeout") {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { reject(new Error("Deadline")); }, { once: true });
        }));
      }
      const command = process.env.OAR_KIMI_BIN === undefined ? "kimi" : resolvePath(process.env.OAR_KIMI_BIN);
      const result = await kimiRuntime.skills({ kind: "available", via: "executable", command }, { cwd: f.cwd, env: f.env, timeoutMs: mode === "timeout" ? 15_000 : 30_000 });
      if (mode === "success") {
        assert.equal(result.kind, "ok");
        expect(result).toMatchObject({ partial: false, view: "discovered" });
        expect(result.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "update-config", source: "builtin" }),
          expect.objectContaining({ name: "oar-inventory", source: "project" }),
        ]));
        expect(await readFile(join(f.data, "config.toml"), "utf8")).toBe(f.config);
      } else { expect(result).toMatchObject({ kind: "unavailable", code: mode === "timeout" ? "timeout" : "query_failed" }); }
      await assertStopped(f.trace);
    } finally {
      vi.restoreAllMocks();
      await rm(f.root, { recursive: true, force: true });
    }
  }, 45_000);
});
