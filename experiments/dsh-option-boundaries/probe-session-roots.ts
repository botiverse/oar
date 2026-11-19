/** Isolated, non-temporary writable roots so the platform's temp-directory exception cannot satisfy a test. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { say, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { withNativeProbe } from "./native-probe.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/dsh-session-roots.json");
const source = `async probe(request) {
  const { agent } = owned(request.sessionId);
  const session = agent.session;
  const service = ctx.get("sandboxPolicy");
  if (request.grant) service.registerWritableRoot(session, request.grant);
  const policy = service.resolve({ session });
  if (!request.file) return { policy };
  const files = ctx.get("fs");
  let fileWrite = false;
  let fileError;
  try {
    const target = await files.resolve(request.file, { cwd: session.cwd });
    await files.writeText(target, "file", undefined, undefined, policy);
    fileWrite = await files.readText(target) === "file";
  } catch (error) { fileError = String(error); }
  const shell = ctx.get("shell");
  const spec = shell.resolve({ command: request.command, cwd: session.cwd, sandboxPolicy: policy, signal: new AbortController().signal });
  const execution = await shell.execute(spec);
  const result = await execution.result();
  return { policy, fileWrite, fileError, shellCode: result.exitCode, shellError: result.stderr?.text, sandbox: result.sandbox };
},`;
await mkdir("oar-trial-run", { recursive: true });
const root = await mkdtemp(path.resolve("oar-trial-run/dsh-session-roots-"));
const primary = path.join(root, "primary");
const configured = path.join(root, "configured");
const extra = path.join(root, "extra");
const sourceId = randomUUID();
const peerId = randomUUID();
const observations: unknown[] = [];
await Promise.all([primary, configured, extra].map(async (directory) => { await mkdir(directory); }));
try {
  await withDshFixture(() => say("unused"), async fixture => {
    async function check(mode: "read-only" | "workspace-write", resume: boolean): Promise<void> {
      await withNativeProbe(fixture, { source, rows: [{ id: "sandbox-policy", config: { mode, additionalWritableRoots: [configured] } }] }, async control => {
        const id = mode === "read-only" ? randomUUID() : sourceId;
        await control.request(resume ? "resume" : "open", { sessionId: id, cwd: primary });
        const peer = resume || mode === "read-only" ? randomUUID() : peerId;
        await control.request("open", { sessionId: peer, cwd: primary });
        const write = async (sessionId: string, target: string, allowed: boolean): Promise<void> => {
          const unique = randomUUID();
          const shellPath = path.join(target, `${unique}.shell`);
          const result = await control.request("probe", { sessionId, file: path.join(target, `${unique}.file`), command: `printf shell > '${shellPath.replaceAll("'", String.raw`'\''`)}'` });
          observations.push({ mode, resume, target: path.basename(target), allowed, result });
          assert.equal(result.fileWrite, allowed, JSON.stringify(result));
          assert.equal(result.shellCode === 0, allowed, JSON.stringify(result));
        };
        await write(id, extra, false);
        await control.request("probe", { sessionId: id, grant: extra });
        await write(id, primary, mode === "workspace-write");
        await write(id, configured, mode === "workspace-write");
        await write(id, extra, mode === "workspace-write");
        await write(peer, extra, false);
      });
    }
    await check("workspace-write", false);
    await check("workspace-write", true);
    await check("read-only", false);
  });
} finally {
  await writeFile(output, JSON.stringify(observations, null, 2));
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ platform: process.platform, checks: observations.length, passed: true }));
