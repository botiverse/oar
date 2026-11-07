/* oxlint-disable eslint/no-await-in-loop -- Each observation depends on the previous native step. */
import { parseJson } from "../../packages/oar/src/shared/json.js";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexInstallation, codexSession, awaitIdle, type Session } from "../../packages/oar/src/index.js";
import { startCodexAimock } from "../../sea-trial/harness/aimock.js";

async function bounded<T>(work: Promise<T>): Promise<T> {
  const stop = new AbortController();
  try { return await Promise.race([work, delay(15_000, undefined, { signal: stop.signal }).then(() => { throw new Error("Probe timed out"); })]); }
  finally { stop.abort(); }
}
const output = process.argv[2] ?? "oar-trial-run/tool-activity";
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "oar-review-audit-"));
const wire = path.join(root, "wire.jsonl");
const proxy = path.join(import.meta.dirname, "review-proxy.ts");
await chmod(proxy, 0o755);
const requests: unknown[] = [];
let seen = Promise.withResolvers<void>();
let release = Promise.withResolvers<void>();
const provider = await startCodexAimock(mock => {
  mock.on({ predicate: () => true }, async request => {
    requests.push(request);
    seen.resolve();
    await release.promise;
    return { content: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"Audit complete","overall_confidence_score":1}' };
  });
});
const installation = await codexInstallation();
if (installation.kind !== "available" || installation.via === "bundled") { throw new Error("Codex unavailable"); }
let session: Session | null = null;
const results: unknown[] = [];
try {
  session = await codexSession({ ...installation, command: proxy }, { cwd: root, env: { ...provider.env, AUDIT_CODEX: installation.command, AUDIT_WIRE: wire, AUDIT_MATCH_REVIEW: process.env.AUDIT_MATCH_REVIEW ?? "0" }, model: "gpt-5.5" });
  for (const mode of ["review", "normal"]) {
    seen = Promise.withResolvers<void>(); release = Promise.withResolvers<void>();
    const prompt = await session.prompt(`AUDIT_${mode}`);
    assert.equal(prompt.kind, "accepted");
    await bounded(seen.promise);
    assert.ok(session.steer !== undefined);
    const steer = await session.steer(`STEER_${mode}`);
    results.push({ mode, prompt, steer });
    assert.equal(steer.kind, mode === "review" ? "rejected" : "accepted");
    if (steer.kind === "rejected") { assert.equal(steer.code, "runtime_refused"); }
    release.resolve();
    const idle: Awaited<ReturnType<typeof awaitIdle>> = await bounded(awaitIdle(session));
    results.push({ mode, idle });
    assert.deepEqual(idle, { kind: "completed" });
  }
} finally {
  release.resolve();
  await writeFile(path.join(output, "review.json"), JSON.stringify({ installation, results, records: session?.records(), requests, wire: await readFile(wire, "utf8").then(text => text.trim().split("\n").map(line => parseJson(line))) }, null, 2));
  await session?.dispose();
  await provider.stop();
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
