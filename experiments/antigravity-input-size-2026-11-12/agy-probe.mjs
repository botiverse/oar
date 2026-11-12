/* oxlint-disable eslint/no-await-in-loop, eslint/no-promise-executor-return, eslint/require-unicode-regexp, promise/avoid-new, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/promise-function-async, typescript/strict-boolean-expressions, typescript/strict-void-return -- The probe as it was run on the signed-in machine, against the published @botiverse/oar package, which this repository's type resolution does not see. */
// Two Antigravity checks for OAR, on a machine where `agy` is signed in.
// Run in an empty directory:  npm i @botiverse/oar@0.102.0 && node agy-probe.mjs [env|size|both]
// - env:  does agy pass its own process environment to a stdio MCP server it starts?
//         Uses a synthetic marker value, no credential. Opens a session; sends one tiny prompt only if the server has not started by then.
// - size: is a single prompt above ~192,000 bytes truncated? Sends one prompt of ~250 KB (costs model tokens, roughly 60k input).
// Prints one JSON line per check. Prints no prompt text, model text beyond the checked word, or account details.
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRuntimes, promptAndWait } from "@botiverse/oar";

const which = process.argv[2] ?? "both";
const runtime = defaultRuntimes.require("antigravity");
const installation = await runtime.installation();
if (installation.kind !== "available") { console.log(JSON.stringify({ error: "agy not found", installation })); process.exit(1); }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function envCheck() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oar-agy-env-"));
  const mark = path.join(dir, "mark.txt");
  const session = await runtime.session(installation, {
    cwd: dir,
    env: { OAR_PROBE_MARK: "present-in-agy-env" },
    mcpServers: [{ name: "oarprobe", command: "/bin/sh", args: ["-c", `printf '%s' "\${OAR_PROBE_MARK:-absent}" > '${mark}'; exec cat >/dev/null`] }],
  });
  let startedBy = "session_open";
  for (let i = 0; i < 20 && !existsSync(mark); i += 1) { await wait(500); }
  if (!existsSync(mark)) {
    startedBy = "first_prompt";
    await promptAndWait(session, "Reply with the single word OK.");
    for (let i = 0; i < 20 && !existsSync(mark); i += 1) { await wait(500); }
  }
  const seen = existsSync(mark) ? readFileSync(mark, "utf8") : null;
  await session.dispose();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ check: "mcp_child_inherits_agy_env", agyVersion: installation.version, serverStarted: seen !== null, startedBy: seen === null ? null : startedBy, markerSeenByServer: seen }));
}

async function sizeCheck() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oar-agy-size-"));
  const session = await runtime.session(installation, { cwd: dir });
  let text = "";
  session.events((event) => { if (event.kind === "text_delta") { text += event.text; } }, { coalesceText: true });
  const filler = "lorem ipsum dolor sit amet ".repeat(Math.ceil(250_000 / 27));
  const word = `ZEBRA${Math.floor(Math.random() * 9000 + 1000)}`;
  const prompt = `Ignore the filler. ${filler}\nThe final code word is ${word}. Reply with only the final code word.`;
  const run = await promptAndWait(session, prompt);
  await session.dispose();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ check: "large_prompt", agyVersion: installation.version, promptBytes: Buffer.byteLength(prompt), outcome: "outcome" in run ? run.outcome.kind : run.kind, sawFinalWord: text.includes(word), replyMentionsTruncated: /truncat/i.test(text) }));
}

if (which === "env" || which === "both") { await envCheck(); }
if (which === "size" || which === "both") { await sizeCheck(); }
