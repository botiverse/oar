/* oxlint-disable import/max-dependencies, eslint/max-statements, eslint/max-params -- Public Grok placement with real fixture transports and lifecycle observations. */
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { AvailableInstallation } from "../../packages/oar/src/contracts/installation.js";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { grokRuntime } from "../../packages/oar/src/runtimes/grok/index.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { opening, text } from "../fixtures/acp-shared-support.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
// oxlint-disable-next-line import/no-namespace -- Preserve the real profile with only its executable fixture substituted.
import type * as GrokSessionModule from "../../packages/oar/src/runtimes/grok/session.js";

vi.mock("../../packages/oar/src/runtimes/grok/session.js", async importOriginal => {
  const actual = await importOriginal<typeof GrokSessionModule>();
  const profile = { ...actual.grokAcpProfile, args: [fileURLToPath(new URL("../fixtures/fake-acp-shared.mjs", import.meta.url))],
    withLaunchArgs: (args: readonly string[], extra: readonly string[]) => [...args, ...extra], terminalShellCommand: false, abortTimeoutMs: 60 };
  return { ...actual, grokAcpProfile: profile, grokSession: acpSession(profile) };
});
vi.mock("../../packages/oar/src/runtimes/grok/sharing-admission.js", async importOriginal => {
  const actual = await importOriginal<{ grokSharedRefusal: (i: AvailableInstallation, p: NodeJS.Platform, a: string) => string | null }>();
  return { ...actual, grokSharedRefusal: (i: AvailableInstallation) => actual.grokSharedRefusal(i, "linux", "x64") };
});
const sessions: Session[] = []; const roots: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async session => { await session.dispose(); }));
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }); }));
});
const installation = { kind: "available", via: "executable", command: process.execPath, version: "grok 1.0.70 (f50904eaee6c) [stable]" } as const;
const exits = (session: Session) => session.records().filter(r => r.kind === "response" && r.body.kind === "exited");
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "oar-grok-sharing-")); roots.push(root);
  await mkdir(path.join(root, "a")); await mkdir(path.join(root, "b"));
  const runtime = grokRuntime.withPlacement("auto");
  const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), HOME: root, USERPROFILE: root,
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "comspec", "pathext", "temp", "tmp"].includes(key.toLowerCase()))),
    PATH: path.dirname(process.execPath), FIXTURE_GROK: "1", FIXTURE_AGENT_VERSION: "1.0.70" };
  return { root, runtime, env, open: async (name: string, options: Partial<SessionOptions> = {}, selected = runtime, i: AvailableInstallation = installation) => {
    const session = await selected.session(i, { cwd: path.join(root, name), env, ...options }); sessions.push(session); return session;
  } };
}

test("same-directory concurrent roots and reuse after release keep sharing; a new Runtime owns a separate pool", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("a")]);
  expect([a.placement, b.placement]).toEqual(["shared", "shared"]); expect(opening(a)?.pid).toBe(opening(b)?.pid);
  expect(opening(a)?.initialized).toBe(1); expect(opening(b)?.initialized).toBe(1);
  await a.dispose(); const c = await f.open("a"); expect(c.placement).toBe("shared"); expect(opening(c)?.pid).toBe(opening(b)?.pid);
  expect(a.records().filter(r => r.kind === "response" && r.body.kind === "released")).toHaveLength(1);
  const separate = await f.open("a", {}, f.runtime.withPlacement("shared")); expect(opening(separate)?.pid).not.toBe(opening(b)?.pid);
  expect(await promptAndWait(b, "peer")).toMatchObject({ kind: "ended" });
  await c.dispose(); await b.dispose(); expect(exits(b)).toHaveLength(1);
});

test("cwd and MCP vary within a pool; environment and initialization system prompts split it", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a", { mcpServers: [{ name: "a", command: "node" }] }), f.open("b", { mcpServers: [{ name: "b", command: "node" }] })]);
  expect(opening(a)).toMatchObject({ cwd: path.join(f.root, "a"), servers: ["a"] });
  expect(opening(b)).toMatchObject({ cwd: path.join(f.root, "b"), servers: ["b"] }); expect(opening(a)?.pid).toBe(opening(b)?.pid);
  const env = await f.open("a", { env: { ...f.env, GROK_DISABLE_AUTOUPDATER: "1" } });
  const prompt = await f.open("a", { systemPrompt: "a different system" });
  const rules = await f.open("a", { appendSystemPrompt: "a different rule" });
  expect(new Set([a, env, prompt, rules].map(s => opening(s)?.pid)).size).toBe(4);
});

test("unknown version and launchArgs fall back under auto; explicit shared refuses with placement", async () => {
  const f = await fixture(); const shared = f.runtime.withPlacement("shared");
  const unknown = { ...installation, version: "grok 1.0.71 (abc) [stable]" };
  const newer = await f.open("a", {}, f.runtime, unknown); expect(newer.placement).toBe("isolated");
  const custom = await f.open("a", { launchArgs: ["custom"] }); expect(custom.placement).toBe("isolated");
  await expect(f.open("a", {}, shared, unknown)).rejects.toMatchObject({ option: "placement" });
  await expect(f.open("a", { launchArgs: ["custom"] }, shared)).rejects.toMatchObject({ option: "placement" });
});

test.each(["", "1.0.71", "1.0.70-dev"])("stale installation cannot admit running native version %j, including simultaneous opens", async nativeVersion => {
  const f = await fixture(); const trace = path.join(f.root, "trace.jsonl");
  const env = { ...f.env, FIXTURE_AGENT_VERSION: nativeVersion, FIXTURE_TRACE_FILE: trace };
  const [a, b] = await Promise.all([f.open("a", { env }), f.open("b", { env })]);
  expect([a.placement, b.placement]).toEqual(["isolated", "isolated"]); expect(opening(a)?.pid).not.toBe(opening(b)?.pid);
  await expect(f.open("a", { env }, f.runtime.withPlacement("shared"))).rejects.toMatchObject({ option: "placement" });
  const contents = await readFile(trace, "utf8"); const rows = contents.trim().split("\n").map(s => asRecord(JSON.parse(s)));
  const byPid = new Map<unknown, unknown[]>();
  for (const row of rows) { const methods = byPid.get(row?.pid) ?? []; methods.push(row?.method); byPid.set(row?.pid, methods); }
  expect([...byPid.values()].filter(methods => methods.length === 1 && methods[0] === "initialize")).toHaveLength(2);
});

test("same installation snapshot rechecks the native version after pool exit", async () => {
  const f = await fixture(); const file = path.join(f.root, "version.txt"); const env = { ...f.env, FIXTURE_AGENT_VERSION_FILE: file };
  await writeFile(file, "1.0.70"); const a = await f.open("a", { env }); expect(a.placement).toBe("shared"); await a.dispose();
  await writeFile(file, "1.0.71"); const b = await f.open("a", { env }); expect(b.placement).toBe("isolated"); await b.dispose();
  await writeFile(file, "1.0.70"); const recovered = await f.open("a", { env }); expect(recovered.placement).toBe("shared");
});

test("child routing preserves fixed allow policy and child request ids; unowned permissions never reach a peer", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("a")]);
  await promptAndWait(a, "grok-child");
  expect(a.graph().edges).toEqual(expect.arrayContaining([expect.objectContaining({ parent: a.id, child: `${a.id}-child` })]));
  expect(text(a)).toContain("early-grok-child"); expect(text(a)).toContain(`allow-${a.id}-child`);
  expect(a.records().filter(r => r.kind === "request" && r.direction === "toApp").every(r => r.sessionId === `${a.id}-child`)).toBe(true);
  expect(b.graph().edges).toEqual([]); expect(text(b)).not.toContain("child");
  await promptAndWait(a, "unowned-permission"); expect(text(a)).toContain("unowned-permission-refused");
  expect(b.records().some(r => r.kind === "request" && r.direction === "toApp")).toBe(false);
});

test("occupied resume refuses, retired resume falls back before native resume, and abort fallback releases only its lease", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("a")]);
  await expect(f.open("a", { resume: a.id })).rejects.toMatchObject({ reason: "in_use" });
  const pending = await a.prompt("ignore-cancel"); await a.abort();
  expect(await awaitTurnEnd(a, pending.request.seq)).toMatchObject({ kind: "aborted" });
  expect(a.records().filter(r => r.kind === "response" && r.body.kind === "released")).toHaveLength(1);
  expect(await promptAndWait(b, "still-alive")).toMatchObject({ kind: "ended" }); await a.dispose();
  const resumed = await f.open("a", { resume: a.id }); expect(resumed.placement).toBe("isolated"); expect(resumed.id).toBe(a.id);
  expect(exits(b)).toHaveLength(0); await b.dispose(); expect(exits(b)).toHaveLength(1);
});

test("shared crash emits one final exit per root after cleanup, within the Windows cleanup budgets", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("a")]); await a.prompt("exit");
  try { await expect.poll(() => [exits(a).length, exits(b).length], { timeout: 15_000 }).toEqual([1, 1]); }
  catch (error) { throw new Error(JSON.stringify({ a: a.records(), b: b.records() }), { cause: error }); }
  expect(exits(a)[0]?.body).toMatchObject({ code: 7 }); expect(exits(b)[0]?.body).toMatchObject({ code: 7 });
  await a.dispose(); await b.dispose(); expect([exits(a).length, exits(b).length]).toEqual([1, 1]);
});

test("Grok records and native errors use the union of overlapping and retired peer credentials", async () => {
  const f = await fixture(); const secret = "fixture-grok-private-credential";
  const a = await f.open("a", { mcpServers: [{ name: "a", command: "node", env: { API_KEY: secret } }] });
  const b = await f.open("a", { mcpServers: [{ name: "b", command: "node", env: { API_KEY: `${secret}-long-tail` } }] });
  await promptAndWait(a, "peer-secret"); await b.dispose();
  await promptAndWait(a, "peer-secret");
  const outcome = await promptAndWait(a, "peer-secret-error");
  const retained = JSON.stringify({ records: a.records(), outcome });
  expect(retained).toContain("[redacted]"); expect(retained).not.toContain(secret); expect(retained).not.toContain("long-tail");
});
