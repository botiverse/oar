/* oxlint-disable max-statements -- Keep the public placement refusal and live process control in one regression. */
/** Production placement cannot inherit the experimental adapter's passing controls. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { grokRuntime } from "../../packages/oar/src/runtimes/grok/index.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { opening } from "../fixtures/acp-shared-support.js";
// oxlint-disable-next-line import/no-namespace -- Replace only the executable with a deterministic native fixture.
import type * as GrokSessionModule from "../../packages/oar/src/runtimes/grok/session.js";

vi.mock("../../packages/oar/src/runtimes/grok/session.js", async importOriginal => {
  const actual = await importOriginal<typeof GrokSessionModule>();
  const { fileURLToPath } = await import("node:url");
  const { acpSession } = await import("../../packages/oar/src/shared/acp/session.js");
  const profile = { ...actual.grokAcpProfile, args: [fileURLToPath(new URL("../fixtures/fake-acp-shared.mjs", import.meta.url))] };
  return { ...actual, grokAcpProfile: profile, grokSession: acpSession(profile) };
});
const sessions: Session[] = []; const roots: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async s => { await s.dispose(); }));
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }); }));
});

test.each(["grok 1.0.70 (f50904eaee6c)", "grok 1.0.70 (f50904eaee6c) [stable]", "grok 1.0.71 (abc) [stable]"])("%s never shares, even without session MCP or with only HTTP MCP", async version => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oar-grok-not-admitted-")); roots.push(root);
  const cwd = path.join(root, "project"); await mkdir(cwd);
  const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])),
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "comspec", "pathext", "temp", "tmp"].includes(key.toLowerCase()))),
    PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, FIXTURE_GROK: "1", FIXTURE_HTTP_MCP: "1", FIXTURE_AGENT_VERSION: "1.0.70" };
  const installation = { kind: "available", via: "executable", command: process.execPath, version } as const;
  const runtime = grokRuntime.withPlacement("auto");
  const a = await runtime.session(installation, { cwd, env }); sessions.push(a);
  const b = await runtime.session(installation, { cwd, env, mcpServers: [{ name: "remote", type: "http", url: "http://127.0.0.1/fixture" }] }); sessions.push(b);
  expect([a.placement, b.placement]).toEqual(["isolated", "isolated"]);
  expect(opening(a)?.pid).not.toBe(opening(b)?.pid);
  const rejected = runtime.withPlacement("shared").session(installation, { cwd, env });
  await expect(rejected).rejects.toMatchObject({ option: "placement" });
  await expect(rejected).rejects.toThrow("configured stdio MCP");
});
