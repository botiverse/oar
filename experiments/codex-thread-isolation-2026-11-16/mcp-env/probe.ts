/** Synthetic native evidence, with every CODEX_HOME file scanned before cleanup. */
/* oxlint-disable no-await-in-loop -- Ordered phases distinguish live state from restart persistence. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { childSource } from "./child-source.js";
import { codexFixture } from "../../sharing/codex-fixture.js";
import { asRecord, type JsonRecord } from "../../../packages/oar/src/shared/json.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-mcp-env");
await mkdir(out, { recursive: true });
const tokens = Object.fromEntries(["mcpA", "mcpB", "shellA", "shellB", "processDefault", "unlisted", "allowed"].map(key => [key, `OAR_SYNTHETIC_243_${key}_20261116_TOKEN`]));
const hits = (bytes: Uint8Array | string): string[] => Object.entries(tokens).filter(([, token]) => Buffer.from(bytes).includes(token)).map(([key]) => key);
const scans: JsonRecord[] = [];
async function scan(root: string, phase: string): Promise<void> {
  const files: JsonRecord[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(file); }
      else if (entry.isFile()) {
        try { const bytes = await readFile(file); files.push({ file: path.relative(root, file), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), hits: hits(bytes) }); }
        catch (error) { files.push({ file: path.relative(root, file), error: String(error) }); }
      } else { files.push({ file: path.relative(root, file), nonRegular: true, ...(entry.isSymbolicLink() ? { symlink: await readlink(file) } : {}) }); }
    }
  }
  await visit(root); scans.push({ phase, files });
}
const fixture = await codexFixture();
const phases: JsonRecord[] = [];
let failure: string | null = null;
try {
  assert.equal(fixture.installation.version, "codex-cli 0.169.0");
  const codexHome = fixture.provider.env?.CODEX_HOME; assert.ok(codexHome !== undefined && codexHome.length > 0);
  const child = path.join(fixture.home, "child.cjs");
  await writeFile(child, childSource);
  await writeFile(path.join(fixture.home, "tool.mjs"), `import ${JSON.stringify(child)};\n`);
  await writeFile(path.join(fixture.home, "children.jsonl"), "");
  const launch = { OAR_MCP_TOKEN: tokens.processDefault ?? "", OAR_UNLISTED_CONTROL: tokens.unlisted ?? "", OAR_ALLOWED_CONTROL: tokens.allowed ?? "" };
  const config = (label: string): JsonRecord => ({ shell_environment_policy: { set: { OAR_SHELL_TOKEN: tokens[`shell${label}`] } },
    mcp_servers: { scope: { command: process.execPath, args: [child, "mcp"], env: { OAR_MCP_TOKEN: tokens[`mcp${label}`] }, env_vars: ["OAR_ALLOWED_CONTROL"], enabled: true } } });
  const ids: string[] = [];
  for (const phase of ["start", "resume-omitted", "resume-supplied"]) {
    const client = await fixture.connect(launch);
    const turns: JsonRecord[] = [];
    const row: JsonRecord = { phase, turns }; phases.push(row);
    for (const [index, label] of ["A", "B"].entries()) {
      const result = await fixture.request(client, phase === "start" ? "thread/start" : "thread/resume", {
        ...(phase === "start" ? { cwd: fixture.cwds[0], model: "gpt-5.1", approvalPolicy: "never" } : { threadId: ids[index] }),
        ...(phase === "resume-omitted" ? {} : { config: config(label) }),
      });
      const id = asRecord(result.thread)?.id; assert.equal(typeof id, "string");
      if (phase === "start") { ids.push(String(id)); }
    }
    await scan(codexHome, `${phase}-before-prompts`);
    for (const [index, label] of ["A", "B"].entries()) {
      const id = ids[index]; assert.ok(id !== undefined && id.length > 0);
      for (const kind of ["mcp", "cwd"]) {
        const key = `${label}_${kind}`; fixture.stages.delete(key);
        const turn = await fixture.turn(client, id, key);
        turns.push({ label, kind, turn });
        assert.equal(turn.status, "completed");
      }
    }
    const journal = await readFile(path.join(fixture.home, "children.jsonl"), "utf8");
    row.childrenThroughPhase = journal.trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line));
    await scan(codexHome, `${phase}-live`);
    client.kill(); await client.exited;
    await scan(codexHome, `${phase}-stopped`);
  }
} catch (error) { failure = String(error); }
finally {
  const { raw } = fixture.provider;
  await writeFile(path.join(out, "evidence.json"), JSON.stringify({ platform: process.platform, installation: fixture.installation, tokens, failure, phases, scans,
    providerScans: raw.map((request, index) => ({ index, hits: hits(JSON.stringify(request)) })),
    native: { calls: fixture.calls, events: fixture.events, rawRequests: raw } }, null, 2));
  await fixture.stop();
}
console.log(JSON.stringify({ phases: phases.map(row => row.phase), failure }));
assert.equal(failure, null, "native evidence retained on failure");
