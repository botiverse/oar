/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- The probe as it was run on the signed-in machine, against the published @botiverse/oar package, which this repository's type resolution does not see. */
// Antigravity large-input check, round 2. Instruction first, code words at both ends.
// Usage (same dir as before): node agy-size2.mjs 185000 && node agy-size2.mjs 200000
// The model is told at the top to reply with the code words it can see. An end word missing at
// 200,000 bytes but present at 185,000 supports a cut model input (not only a cut transcript); it does not prove it.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRuntimes, promptAndWait } from "@botiverse/oar";

const bytes = Number(process.argv[2] ?? "200000");
const runtime = defaultRuntimes.require("antigravity");
const installation = await runtime.installation();
if (installation.kind !== "available") { console.log(JSON.stringify({ error: "agy not found" })); process.exit(1); }
const dir = mkdtempSync(path.join(os.tmpdir(), "oar-agy-size2-"));
const session = await runtime.session(installation, { cwd: dir });
let text = "";
session.events((event) => { if (event.kind === "text_delta") { text += event.text; } }, { coalesceText: true });
const n = () => Math.floor(Math.random() * 9000 + 1000);
const start = `START${n()}`;
const end = `FINISH${n()}`;
const head = `Do not use any tools. Reply with every code word in capital letters you can see in this message, separated by spaces, and nothing else. Code word: ${start}.\n`;
const tail = `\nCode word: ${end}.`;
const fillerBytes = Math.max(0, bytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
const prompt = head + "lorem ipsum dolor sit amet ".repeat(Math.ceil(fillerBytes / 27)).slice(0, fillerBytes) + tail;
const timer = setTimeout(async () => {
  console.log(JSON.stringify({ check: "large_prompt_2", promptBytes: Buffer.byteLength(prompt), outcome: "timeout_180s", sawStart: text.includes(start), sawEnd: text.includes(end) }));
  await session.dispose(); rmSync(dir, { recursive: true, force: true }); process.exit(0);
}, 180_000);
const run = await promptAndWait(session, prompt);
clearTimeout(timer);
await session.dispose();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ check: "large_prompt_2", agyVersion: installation.version, promptBytes: Buffer.byteLength(prompt), outcome: "outcome" in run ? run.outcome.kind : run.kind, sawStart: text.includes(start), sawEnd: text.includes(end), replyLength: text.length }));
