/* oxlint-disable import/max-dependencies, eslint/max-statements -- Adapter regression drives real ACP fixture processes through public Runtime placement. */
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import type { AvailableInstallation } from "../../packages/oar/src/contracts/installation.js";
// oxlint-disable-next-line import/no-namespace -- Observe real fixture process lifecycle.
import * as acp from "../../packages/oar/src/shared/acp/process.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
// oxlint-disable-next-line import/no-namespace -- Type of the complete module retained by Vitest importOriginal.
import type * as OpenCodeSessionModule from "../../packages/oar/src/runtimes/opencode/session.js";

vi.mock("../../packages/oar/src/runtimes/opencode/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenCodeSessionModule>();
  const profile = { ...actual.opencodeV2AcpProfile, args: [fileURLToPath(new URL("../fixtures/fake-acp-shared.mjs", import.meta.url))], resumeKeepsSessionCwd: false };
  return { ...actual, opencodeV2AcpProfile: profile, opencodeSession: acpSession(profile) };
});
// Only admission is fixed. Filesystem and process behavior still run on the actual host OS.
vi.mock("../../packages/oar/src/runtimes/opencode/sharing-admission.js", async importOriginal => {
  const actual = await importOriginal<{ opencodeSharedRefusal: (installation: AvailableInstallation, platform: NodeJS.Platform, arch: string) => string | null }>();
  return { ...actual, opencodeSharedRefusal: (value: AvailableInstallation) => actual.opencodeSharedRefusal(value, "linux", "x64") };
});
const sessions: Session[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async session => { await session.dispose(); }));
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }); }));
});
const installation = { kind: "available", via: "executable", command: process.execPath, version: "opencode v2.2.5" } as const;
function exits(session: Session) { return session.records().filter(r => r.kind === "response" && r.body.kind === "exited"); }
function launched(spy: MockInstance<typeof acp.startAcpProcess>, index: number): acp.AcpProcess {
  const result = spy.mock.results[index];
  if (result?.type !== "return") { throw new Error("Expected a started native process"); }
  return result.value;
}
function pid(session: Session): unknown {
  const record = session.records().find(r => r.kind === "frame" && ["session/new", "session/resume"].includes(r.body.type));
  return record?.kind === "frame" ? asRecord(record.body.native)?.pid : null;
}
async function fixture(version = "2.2.5") {
  const root = await mkdtemp(path.join(os.tmpdir(), "oar-opencode-sharing-")); roots.push(root);
  await Promise.all(["a", "b", "c"].map(async name => { await mkdir(path.join(root, name)); }));
  const runtime = opencodeRuntime.withPlacement("auto");
  const env = { HOME: root, USERPROFILE: root, PATH: path.dirname(process.execPath), FIXTURE_AGENT_VERSION: version };
  return { root, runtime, env, open: async (name: string, selected = runtime, resume?: string) => {
    const session = await selected.session({ ...installation, version: `opencode v${version}` }, { cwd: path.join(root, name), env, ...(resume === undefined ? {} : { resume }) }); sessions.push(session); return session;
  } };
}

test.each(["2.2.3", "2.2.5"])("%s auto shares distinct directories; aliases and lifetime reuse fall back before native open", async version => {
  const f = await fixture(version);
  const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  expect(a.placement).toBe("shared"); expect(pid(a)).toEqual(pid(b));
  await symlink(path.join(f.root, "a"), path.join(f.root, "alias"), "junction");
  const duplicate = await f.open("alias");
  expect(duplicate.records().find(r => r.kind === "frame" && r.body.type === "session/new")?.body).toMatchObject({ native: { cwd: path.join(f.root, "alias") } });
  expect(duplicate.placement).toBe("isolated"); expect(pid(duplicate)).not.toEqual(pid(a));
  await a.dispose();
  const reused = await f.open("a"); expect(reused.placement).toBe("isolated"); expect(pid(reused)).not.toEqual(pid(b));
  expect(reused.records().find(r => r.kind === "response" && r.body.kind === "opened")?.body).toEqual({ kind: "opened", placement: "isolated" });
  expect(await promptAndWait(b, "still-peer")).toMatchObject({ kind: "ended" });
  await b.dispose();
  const fresh = await f.open("a"); expect(fresh.placement).toBe("shared"); expect(pid(fresh)).not.toEqual(pid(b));
});

test.each(["2.2.3", "2.2.5"])("%s explicit shared refuses repeated directory even after release; each runtime has its own pool", async version => {
  const f = await fixture(version); const shared = f.runtime.withPlacement("shared");
  const [a, b] = await Promise.all([f.open("a", shared), f.open("b", shared)]);
  await expect(f.open("a", shared)).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
  await a.dispose();
  await expect(f.open("a", shared)).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
  const own = await f.open("a"); expect(pid(own)).not.toEqual(pid(b)); expect(own.placement).toBe("shared");
});

test("concurrent same-directory opens reserve once, and active resume cannot bypass ownership", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("a")]);
  expect([a.placement, b.placement]).toEqual(expect.arrayContaining(["isolated", "shared"]));
  const owner = a.placement === "shared" ? a : b;
  await expect(f.open("a", f.runtime, owner.id)).rejects.toMatchObject({ name: "SessionUnavailableError", reason: "in_use" });
  expect(await promptAndWait(owner, "alive")).toMatchObject({ kind: "ended" });
});

test("explicit isolated and unknown versions keep their own processes", async () => {
  const f = await fixture(); const isolated = f.runtime.withPlacement("isolated");
  const [a, b] = await Promise.all([f.open("a", isolated), f.open("b", isolated)]);
  expect([a.placement, b.placement]).toEqual(["isolated", "isolated"]); expect(pid(a)).not.toEqual(pid(b));
  const newer = await f.runtime.session({ ...installation, version: "2.2.4" }, { cwd: path.join(f.root, "c"), env: f.env }); sessions.push(newer);
  expect(newer.placement).toBe("isolated");
  await expect(f.runtime.withPlacement("shared").session({ ...installation, version: "2.2.4" }, { cwd: f.root })).rejects.toMatchObject({ option: "placement" });
});

test("a failed canonical-directory preflight leaves existing sessions alive", async () => {
  const f = await fixture(); const launches = vi.spyOn(acp, "startAcpProcess");
  const a = await f.open("a");
  await expect(f.open("missing")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await promptAndWait(a, "after-failure")).toMatchObject({ kind: "ended" });
  await a.dispose();
  expect(a.records().filter(r => r.kind === "response" && r.body.kind === "exited")).toHaveLength(1);
  expect(launches).toHaveBeenCalledTimes(1);
  expect(launched(launches, 0).closed).toBe(true); launches.mockRestore();
});

test("directory identity handles case aliases without conflating case-sensitive directories", async () => {
  const f = await fixture(); await mkdir(path.join(f.root, "MixedCase"));
  const a = await f.open("MixedCase");
  await mkdir(path.join(f.root, "mixedcase"), { recursive: true });
  const b = await f.open("mixedcase");
  const { stat } = await import("node:fs/promises");
  const [first, second] = await Promise.all([stat(path.join(f.root, "MixedCase")), stat(path.join(f.root, "mixedcase"))]);
  expect(b.placement).toBe(first.ino === second.ino && first.dev === second.dev ? "isolated" : "shared");
  expect(a.placement).toBe("shared");
});

test("process-level environment changes split pools even for the same directory", async () => {
  const f = await fixture(); const a = await f.open("a");
  const b = await f.runtime.session(installation, { cwd: path.join(f.root, "a"), env: { ...f.env, OPENCODE_DISABLE_AUTOUPDATE: "1" } }); sessions.push(b);
  expect(b.placement).toBe("shared"); expect(pid(b)).not.toEqual(pid(a));
});

test("custom startup arguments fall back under auto and are refused under explicit shared", async () => {
  const f = await fixture();
  const session = await f.runtime.session(installation, { cwd: f.root, env: f.env, launchArgs: ["custom-startup"] }); sessions.push(session);
  expect(session.placement).toBe("isolated");
  await expect(f.runtime.withPlacement("shared").session(installation, { cwd: f.root, env: f.env, launchArgs: ["custom-startup"] })).rejects.toMatchObject({ option: "placement" });
});

test.each(["2.2.4", "2.2.6", "2.2.5-dev", "opencode v2.2.5", ""])("a stale installation cannot admit an actual version %j after the last lease exits", async version => {
  const f = await fixture();
  const versionFile = path.join(f.root, "version.txt"); const traceFile = path.join(f.root, "trace.jsonl");
  const env = { ...f.env, FIXTURE_AGENT_VERSION_FILE: versionFile, FIXTURE_TRACE_FILE: traceFile };
  const open = async (placement: "auto" | "shared") => {
    const session = await f.runtime.withPlacement(placement).session(installation, { cwd: path.join(f.root, "a"), env }); sessions.push(session); return session;
  };
  // Keep the same Runtime, installation snapshot and environment across the executable upgrade.
  const selected = f.runtime.withPlacement("auto");
  await writeFile(versionFile, "2.2.5");
  const a = await selected.session(installation, { cwd: path.join(f.root, "a"), env }); sessions.push(a);
  expect(a.placement).toBe("shared"); await a.dispose();
  await writeFile(versionFile, version);
  const launches = vi.spyOn(acp, "startAcpProcess");
  try {
    const b = await selected.session(installation, { cwd: path.join(f.root, "a"), env }); sessions.push(b);
    expect(b.placement).toBe("isolated"); expect(launches).toHaveBeenCalledTimes(2);
    expect(launched(launches, 0).closed).toBe(true);
    await expect(open("shared")).rejects.toMatchObject({ option: "placement" });
    expect(launches).toHaveBeenCalledTimes(3); expect(launched(launches, 2).closed).toBe(true);
    const contents = await readFile(traceFile, "utf8");
    const trace = contents.trim().split("\n").map(line => asRecord(JSON.parse(line)));
    const processes = new Map<unknown, unknown[]>();
    for (const entry of trace) { const methods = processes.get(entry?.pid) ?? []; methods.push(entry?.method); processes.set(entry?.pid, methods); }
    // Both refused native processes initialized only. Neither received new/resume or MCP credentials.
    expect([...processes.values()].filter(methods => methods.length === 1 && methods[0] === "initialize")).toHaveLength(2);
    await b.dispose(); await writeFile(versionFile, "2.2.5");
    const recovered = await selected.session(installation, { cwd: path.join(f.root, "a"), env }); sessions.push(recovered);
    expect(recovered.placement).toBe("shared");
  } finally { launches.mockRestore(); }
});

test("a shared native crash records exit once for every attached session", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  expect(pid(a)).toEqual(pid(b)); await a.prompt("exit");
  // Final records follow asynchronous process cleanup, including Windows read budgets.
  try { await expect.poll(() => [exits(a).length, exits(b).length], { timeout: 15_000 }).toEqual([1, 1]); }
  catch (error) { throw new Error(`Missing shared exit records: ${JSON.stringify({ a: a.records(), b: b.records() })}`, { cause: error }); }
  for (const session of [a, b]) { expect(exits(session)[0]?.body).toMatchObject({ code: 7 }); }
  await Promise.all([a.dispose(), b.dispose()]);
  expect([exits(a).length, exits(b).length]).toEqual([1, 1]);
});

test("directory read failure does not acquire or start the first shared process", async () => {
  const f = await fixture(); const launches = vi.spyOn(acp, "startAcpProcess");
  try {
    await expect(f.open("missing")).rejects.toMatchObject({ code: "ENOENT" });
    expect(launches).not.toHaveBeenCalled();
    const a = await f.open("a"); expect(a.placement).toBe("shared"); expect(launches).toHaveBeenCalledTimes(1);
  } finally { launches.mockRestore(); }
});
