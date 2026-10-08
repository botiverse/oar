/** Native runtime + local scripted provider only, no login. Evidence: input-interruption-2026-10-08.md. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { interruptedInputProbe } from "../sea-trial/vendor/support/input-interruption.js";

const [id, mode] = process.argv.slice(2);
assert.ok(id === "codex" || id === "claude" || id === "pi" || id === "grok" || id === "opencode", "give codex, claude, pi, grok or opencode");
const report = await interruptedInputProbe(id, mode === "after-read");
const dir = path.resolve("oar-trial-run/input-interruption");
await mkdir(dir, { recursive: true });
const artifact = path.join(dir, `${id}${mode === "after-read" ? "-after-read" : ""}.json`);
await writeFile(artifact, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ id, answers: report.answers, outcome: report.outcome, nextOutcome: report.nextOutcome, inputState: report.input?.state, pending: report.pending, provider: report.provider, artifact }));
