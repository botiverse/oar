/* oxlint-disable import/max-dependencies -- Standalone launch experiment composes existing fixture, redaction and process cleanup helpers. */
/**
 * Compare the npm wrapper, its Node launcher and the native binary using the
 * same isolated Grok configuration and initialize request. No model is called.
 * Run: pnpm tsx experiments/grok-acp-startup.ts "$(npm root -g)"
 * Outcomes are measurements, not a replacement for the required behavior tests.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { grokInstallation } from "../packages/oar/src/runtimes/grok/installation.js";
import { LaunchLeakError, probeLaunch, type LaunchVariant } from "./grok-startup/launch-probe.js";
import { startGrokAimock } from "../sea-trial/harness/aimock-acp.js";

const root = process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run";
const file = path.join(root, "grok-acp-startup.jsonl");
let stage = "prepare_output";
function record(row: Readonly<Record<string, unknown>>): void {
  const line = `${JSON.stringify(row)}\n`;
  try { appendFileSync(file, line); }
  catch { process.stderr.write("[grok launch diagnostic] file write failed; evidence follows in the job log\n"); }
  process.stdout.write(line);
}

function binaryKind(name: string): string {
  if (name.includes(".tmp.")) { return "temporary"; }
  if (name.includes(".link.")) { return "temporary_link"; }
  if (name.endsWith(".old")) { return "backup"; }
  return name.startsWith("grok-") ? "versioned" : "canonical";
}

/** Metadata only: do not read or prepare a binary before a subsequent launch. */
async function binaryState(home: string): Promise<unknown> {
  try {
    const directory = path.join(home, "bin");
    const names = await readdir(directory);
    return await Promise.all(names.filter(name => name.startsWith("grok")).map(async (name) => {
      const kind = binaryKind(name);
      try {
        const metadata = await stat(path.join(directory, name));
        return { kind, bytes: metadata.size };
      }
      catch { return { kind, unreadable: true }; }
    }));
  } catch { return null; }
}

async function main(): Promise<void> {
  await mkdir(root, { recursive: true });
  stage = "validate_arguments";
  const [npmRoot] = process.argv.slice(2);
  assert.ok(npmRoot !== undefined && npmRoot.length > 0, "Pass the installed npm package root");
  const launcher = path.join(npmRoot, "@xai-official", "grok", "bin", "grok-bootstrap.js");
  const native = process.env.GROK_PROBE_NATIVE ?? path.join(
    process.env.GROK_HOME ?? path.join(homedir(), ".grok"), "bin", process.platform === "win32" ? "grok.exe" : "grok",
  );
  stage = "find_launcher";
  assert.ok(existsSync(launcher), "The installed Grok Node launcher must exist");
  stage = "find_native";
  assert.ok(existsSync(native), "The installed Grok native binary must exist");
  stage = "installation";
  const installation = await grokInstallation();
  assert.equal(installation.kind, "available");
  assert.equal(installation.via, "executable");
  const args = ["agent", "--always-approve", "--no-leader", "stdio"];
  const phases = path.resolve(root, "grok-bootstrap", randomUUID());
  await mkdir(phases, { recursive: true });
  const observer = fileURLToPath(new URL("grok-startup/trace-bootstrap.ts", import.meta.url));
  const bootstrapBytes = await readFile(launcher);
  const bootstrapSha256 = createHash("sha256").update(bootstrapBytes).digest("hex");
  record({ phase: "identity", platform: process.platform, version: installation.version,
    node: process.version, bootstrapSha256 });

  interface Variant extends LaunchVariant {
    readonly repeat?: boolean;
    readonly observe?: boolean;
  }

  const variants: readonly Variant[] = [
    { name: "oar-installation", command: installation.command, args, pipes: "pipe", repeat: true },
    { name: "npm-wrapper", command: "grok", args, pipes: "pipe" },
    { name: "node-launcher", command: process.execPath, args: ["--require", observer, launcher, ...args], pipes: "pipe", repeat: true, observe: true },
    { name: "native", command: native, args, pipes: "pipe" },
    { name: "native-overlapped", command: native, args, pipes: "overlapped" },
  ];

  async function runVariant(variant: Variant): Promise<void> {
    stage = `variant:${variant.name}`;
    const fixture = await startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "unused" }); });
    let previousOutcome: string | null = null;
    try {
      for (const attempt of variant.repeat === true ? [1, 2] : [1]) {
        const trace = variant.observe === true ? path.join(phases, `${variant.name}-${String(attempt)}.jsonl`) : null;
        const env = { ...fixture.env, ...(trace === null ? {} : { OAR_GROK_BOOTSTRAP_TRACE: trace }) };
        const context = { name: variant.name, attempt, previousOutcome, trace: trace === null ? null : path.relative(root, trace) };
        record({ phase: "start", at: Date.now(), ...context });
        // oxlint-disable-next-line eslint/no-await-in-loop -- A repeat must reuse HOME only after the previous process exited.
        const result = await probeLaunch(variant, env, { record: row => { record({ ...context, ...row }); } });
        // oxlint-disable-next-line eslint/no-await-in-loop -- Observe materialization left by this attempt before retrying.
        const binaries = await binaryState(fixture.env.GROK_HOME ?? "");
        record({ phase: "binaries", ...context, binaries });
        previousOutcome = result.outcome;
        if (!result.didClose && result.cleanup !== "observed_gone") {
          record({ phase: "repeat_skipped", ...context, reason: "cleanup_unverified" });
          break;
        }
      }
    } finally {
      try { await fixture.stop(); }
      catch { record({ phase: "fixture_cleanup_error", name: variant.name }); }
    }
  }

  for (const variant of variants) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each variant owns a fresh HOME; its repeat alone shares it.
    await runVariant(variant);
  }
}

try { await main(); }
catch (error) {
  if (error instanceof LaunchLeakError) { throw error; }
  // Setup, native refusal and incomplete observation are diagnostic findings.
  record({ phase: "diagnostic_error", at: Date.now(), stage, kind: error instanceof Error ? error.name : "unknown" });
}
