import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
import { startOpencodeAimock } from "../harness/aimock-acp.js";

test.skipIf(process.env.OAR_TEST !== "opencode-aimock")("v2 lists project model variants without changing defaults or creating a session", async context => {
  const fixture = await startOpencodeAimock(() => {});
  try {
    const { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data } = fixture.env;
    assert.ok(home !== undefined && config !== undefined && data !== undefined);
    const keep = new Set(["PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "TEMP", "TMP", "OAR_OPENCODE_BIN"]);
    const stripped = Object.fromEntries(Object.keys(process.env).filter(key => !keep.has(key.toUpperCase())).map(key => [key, null]));
    const env = { ...stripped, ...fixture.env, USERPROFILE: home };
    const cwd = join(home, "project +%");
    await mkdir(cwd);
    const globalFile = join(config, "opencode", "opencode.json");
    const defaults = await readFile(globalFile, "utf8");
    const project = JSON.stringify({ provider: { fixture: {
      npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:9", apiKey: "fixture" },
      models: {
        reason: { name: "Reasoner", variants: { low: {}, default: {}, high: {} } },
        plain: { name: "Plain", variants: { default: {} } },
        other: { name: "Other", variants: { max: {} } },
      },
    } } });
    await writeFile(join(cwd, "opencode.json"), project);
    const installation = await opencodeRuntime.installation({ env });
    assert.equal(installation.kind, "available");
    assert.equal(installation.via, "executable");
    if (!/^(?:opencode\s+)?v?2\./u.test(installation.version ?? "")) { context.skip("v2 model API"); }
    using requests = vi.spyOn(globalThis, "fetch");
    const answer = await opencodeRuntime.listModels(installation, { cwd, env });
    assert.equal(answer.kind, "ok");
    expect(answer.models.filter(row => row.id.startsWith("fixture/"))).toEqual([
      { id: "fixture/other", displayName: "Other", provider: { id: "fixture" }, effortLevels: ["max"] },
      { id: "fixture/plain", displayName: "Plain", provider: { id: "fixture" } },
      { id: "fixture/reason", displayName: "Reasoner", provider: { id: "fixture" }, effortLevels: ["low", "high"] },
    ]);
    expect(await readFile(globalFile, "utf8")).toBe(defaults);
    expect(await readFile(join(cwd, "opencode.json"), "utf8")).toBe(project);
    expect(fixture.raw).toHaveLength(0);
    const reads = requests.mock.calls.map(([url]) => url).filter((url): url is string => typeof url === "string" && url.endsWith("/api/model"));
    assert.equal(reads.length, 1);
    const [url] = reads;
    assert.ok(url !== undefined);
    await expect(fetch(url)).rejects.toThrow();
    using db = new DatabaseSync(join(data, "opencode", "opencode.db"), { readOnly: true });
    expect(db.prepare("SELECT count(*) AS sessions FROM session_v2").get()?.sessions).toBe(0);
  } finally { await fixture.stop(); }
}, 60_000);
