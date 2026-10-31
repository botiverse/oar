/* oxlint-disable import/max-dependencies, eslint/max-statements -- Adapter regression drives real ACP fixture processes through public Runtime placement. */
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
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
const sessions: Session[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async session => { await session.dispose(); }));
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }); }));
});
const installation = { kind: "available", via: "executable", command: process.execPath, version: "opencode v2.2.3" } as const;
function pid(session: Session): unknown {
  const record = session.records().find(r => r.kind === "frame" && ["session/new", "session/resume"].includes(r.body.type));
  return record?.kind === "frame" ? asRecord(record.body.native)?.pid : null;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "oar-opencode-sharing-")); roots.push(root);
  await Promise.all(["a", "b", "c"].map(async name => { await mkdir(path.join(root, name)); }));
  const runtime = opencodeRuntime.withPlacement("auto");
  const env = { HOME: root, USERPROFILE: root, PATH: path.dirname(process.execPath) };
  return { root, runtime, env, open: async (name: string, selected = runtime, resume?: string) => {
    const session = await selected.session(installation, { cwd: path.join(root, name), env, ...(resume === undefined ? {} : { resume }) }); sessions.push(session); return session;
  } };
}

test("auto shares distinct directories; aliases and lifetime reuse fall back before native open", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  expect(a.placement).toBe("shared"); expect(pid(a)).toEqual(pid(b));
  await symlink(path.join(f.root, "a"), path.join(f.root, "alias"), "junction");
  const duplicate = await f.open("alias"); expect(duplicate.placement).toBe("isolated"); expect(pid(duplicate)).not.toEqual(pid(a));
  await a.dispose();
  const reused = await f.open("a"); expect(reused.placement).toBe("isolated"); expect(pid(reused)).not.toEqual(pid(b));
  expect(reused.records().find(r => r.kind === "response" && r.body.kind === "opened")?.body).toEqual({ kind: "opened", placement: "isolated" });
  expect(await promptAndWait(b, "still-peer")).toMatchObject({ kind: "ended" });
  await b.dispose();
  const fresh = await f.open("a"); expect(fresh.placement).toBe("shared"); expect(pid(fresh)).not.toEqual(pid(b));
});

test("explicit shared refuses repeated directory even after release; each runtime has its own pool", async () => {
  const f = await fixture(); const shared = f.runtime.withPlacement("shared");
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

test("a failed canonical-directory read releases only the acquired lease", async () => {
  const f = await fixture(); const a = await f.open("a");
  await expect(f.open("missing")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await promptAndWait(a, "after-failure")).toMatchObject({ kind: "ended" });
  await a.dispose();
  expect(a.records().filter(r => r.kind === "response" && r.body.kind === "exited")).toHaveLength(1);
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
