/**
 * What Codex reports for a dropped stream, a 503 and an unparsable tool argument,
 * and whether a command wrapper's OOM score reaches its processes. See README.md.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexInstallation, codexSession } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { startCodexAimock } from "../../sea-trial/harness/aimock.js";

const CUT_STREAM = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "cut", object: "response", status: "in_progress", output: [] }, sequence_number: 0 })}\n\n`;
const scenario = process.argv[2] ?? "dropped";
let requests = 0;
let cut = 0;
const provider = await startCodexAimock((mock) => {
  mock.on({ predicate: () => true }, () => {
    requests += 1;
    if (scenario === "503" && requests <= 2) { return { status: 503, error: { type: "server_error", message: "probe upstream 503" } }; }
    if (scenario === "badargs" && requests === 1) { return { toolCalls: [{ id: "bad", name: "exec_command", arguments: "{not json" }] }; }
    if (scenario === "badtype" && requests === 1) { return { toolCalls: [{ id: "bad", name: "exec_command", arguments: '{"cmd":"true","max_output_tokens":14380.0}' }] }; }
    if (scenario === "badtype-silent" && requests === 1) { return { toolCalls: [{ id: "bad", name: "exec_command", arguments: '{"cmd":"true","max_output_tokens":14380.0}' }] }; }
    if (scenario === "badtype-silent") { return { content: "" }; }
    if (scenario === "wrapper" && requests === 1) { return { toolCalls: [{ id: "score", name: "exec_command", arguments: JSON.stringify({ cmd: "cat /proc/self/oom_score_adj", yield_time_ms: 5000 }) }] }; }
    return { content: "DONE" };
  });
}, { rewriteResponse: (body) => {
  if (scenario !== "dropped" || cut === 2) { return body; }
  cut += 1;
  return CUT_STREAM;
} });
const installation = await codexInstallation();
if (installation.kind !== "available" || installation.via !== "executable") { throw new Error("codex is not installed"); }
const directory = mkdtempSync(path.join(tmpdir(), "oar-codex-signals-"));
const wrapper = path.join(directory, "codex-wrapper.sh");
writeFileSync(wrapper, `#!/bin/sh\nexec choom -n 500 -- ${JSON.stringify(installation.command)} "$@"\n`);
chmodSync(wrapper, 0o755);
const session = await codexSession(scenario === "wrapper" ? { ...installation, command: wrapper } : installation, {
  cwd: process.cwd(),
  env: { ...provider.env },
  ...(scenario === "wrapper" ? { mcpServers: [{ name: "probe", command: process.execPath, args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"] }] } : {}),
});
const result = await promptAndWait(session, "go", { timeoutMs: 90_000 });
console.log(JSON.stringify({ requests, ended: result.kind === "ended" ? result.outcome : result.kind }));
for (const record of session.records()) {
  if (record.kind === "frame" && record.body.type === "error") { console.log(JSON.stringify({ native: record.body.native, events: record.body.events })); }
  if (record.kind === "frame") { for (const event of record.body.events) { if (event.kind === "tool_call_ended") { console.log(JSON.stringify(event)); } } }
}
if (scenario === "wrapper") {
  const rows = execFileSync("ps", ["-e", "-o", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n").flatMap((line) => {
    const fields = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<name>.*)$/u.exec(line)?.groups;
    return fields === undefined ? [] : [{ pid: Number(fields.pid), ppid: Number(fields.ppid), name: fields.name }];
  });
  const found = rows.filter((row) => row.ppid === process.pid);
  for (const row of found) { found.push(...rows.filter((child) => child.ppid === row.pid)); }
  for (const row of found) {
    try { console.log(row.name, readFileSync(`/proc/${String(row.pid)}/oom_score_adj`, "utf8").trim()); }
    catch { /* A helper that exited since the listing. */ }
  }
}
await session.dispose();
await provider.stop();
rmSync(directory, { recursive: true, force: true });
