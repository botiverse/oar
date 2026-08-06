/**
 * FIRST CONTACT WITH A REAL RUNTIME — the point is what it proves, not that it
 * passes.
 *
 * Everything else in this repository is a type. Types cannot be wrong in a way
 * anything notices: with zero drivers, "sea-trial green across every driver" is
 * green over an empty set, and an empty-set gate is indistinguishable from a
 * satisfied one. This file exists so that stops being true.
 *
 * ⚠️ NO DAEMON. Plain `node:child_process`, nothing from the host monorepo.
 * "Our abstraction is clean" is always self-tellable; "someone without our
 * daemon can drive this runtime" either holds or fails loudly. That is the only
 * claim worth making here, so it is the only one made.
 *
 * Run: node drydock/probes/codex-handshake.ts   (requires `codex` on PATH)
 * Exits non-zero on any unmet expectation.
 *
 * ── OBSERVED 2026-08-06, codex 0.144.6, macOS arm64 ────────────────────────
 *
 * Launch is `codex app-server --listen stdio://`, newline-delimited JSON-RPC.
 * Handshake is `initialize` -> response -> `initialized`, so this runtime earns
 * `readiness: { kind: "handshake_event" }` — the strongest kind. It does not
 * have to settle for `process_spawned`.
 *
 * ⭐ FINDING 1 — the handshake field echoes the CLIENT's own input.
 *   Sending clientInfo.name = "oar-probe" produced
 *   userAgent: "oar-probe/0.144.6 (Mac OS 26.5.1; arm64) ... (oar-probe; 0.0.0)".
 *   Asserting the field is PRESENT is sound. Asserting its CONTENT would be
 *   matching a string we supplied ourselves — a check that passes because of its
 *   own input is not a check. Written down because the tempting "improvement" is
 *   the unsafe one.
 *
 * ⭐ FINDING 2 — the default is SHARED credentials, not isolated ones.
 *   The response reports codexHome = the ambient ~/.codex. So `LaunchSpec.env`
 *   isolation is load-bearing, not a nicety: absent an override, two runtimes
 *   share one credential directory.
 *
 * ⚠️ FINDING 3 — unsolicited traffic. A `remoteControl/status/changed`
 *   notification arrives after the response. `normalise()` must tolerate
 *   messages nobody requested; a reader assuming request/response pairing will
 *   desync.
 */
import { spawn } from "node:child_process";

const TIMEOUT_MS = 15_000;
const INIT_ID = 1;

const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (!ok) {
    failures.push(what);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrowed, never asserted: a cast would let a malformed reply pass by fiat. */
function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function frame(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`;
}

const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let sawResponse = false;
let sawUnsolicited = false;
let stderrBytes = 0;

const timer = setTimeout(() => {
  failures.push(`no initialize response within ${String(TIMEOUT_MS)}ms`);
  child.kill("SIGKILL");
}, TIMEOUT_MS);

function inspectResponse(message: unknown): void {
  sawResponse = true;
  clearTimeout(timer);
  const result = readField(message, "result");
  check(result !== undefined, "initialize returned an error rather than a result");
  check(typeof readField(result, "userAgent") === "string",
    "initialize response is missing the userAgent handshake field");
  // Deliberately not asserting userAgent's content — see FINDING 1.
  check(typeof readField(result, "codexHome") === "string",
    "initialize response is missing codexHome (needed to reason about isolation)");
  child.stdin?.write(frame({ jsonrpc: "2.0", method: "initialized", params: {} }));
  child.kill("SIGTERM");
}

function consume(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    failures.push(`unparseable line on stdout: ${line.slice(0, 80)}`);
    return;
  }
  if (readField(parsed, "id") === INIT_ID) {
    inspectResponse(parsed);
  } else if (readField(parsed, "method") !== undefined) {
    sawUnsolicited = true;
  }
}

function drain(): void {
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() !== "") {
      consume(line);
    }
  }
}

function report(code: number | null, signal: string | null): void {
  console.log(`handshake      ${sawResponse ? "OK" : "MISSING"}`);
  console.log(`unsolicited    ${sawUnsolicited ? "observed (normalise must tolerate)" : "none"}`);
  console.log(`stderr         ${String(stderrBytes)} bytes (not echoed by design)`);
  console.log(`exit           code=${String(code)} signal=${String(signal)}`);
  if (failures.length > 0) {
    console.error(`\nFAILED (${String(failures.length)}):`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }
  console.log("\nPASS — a real codex runtime completed a handshake with no daemon present.");
}

child.stdout?.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  drain();
});

// Bounded and unattributed: stderr may carry credential-shaped text, so it is
// counted, never echoed. Scrubbing is the layer's job; this probe does not open
// the channel at all.
child.stderr?.on("data", (chunk: Buffer) => {
  stderrBytes += chunk.length;
});

/**
 * ⚠️ TERMINAL BY CONSTRUCTION — the first version got this wrong and the
 * negative control caught it.
 *
 * When spawn fails (codex absent from PATH) Node emits `error` and may never
 * emit `exit`. All reporting lived in the `exit` handler, so the probe printed
 * NOTHING and exited 0: it passed loudest exactly when the runtime it exists to
 * contact was absent entirely.
 *
 * That is this project's own thesis reproduced in its own instrument — an
 * absence reported as a success. Kept as a comment because the next probe author
 * will reach for the same shape.
 */
child.on("error", (error: Error) => {
  clearTimeout(timer);
  console.error(`FAILED (1):\n  - could not spawn codex: ${error.message}`);
  console.error("  (absence of the runtime must fail loudly; this once exited 0)");
  process.exit(1);
});

child.on("exit", (code: number | null, signal: string | null) => {
  clearTimeout(timer);
  check(sawResponse, "process ended before completing the initialize handshake");
  check(code === 0 || signal === "SIGTERM",
    `unclean shutdown: code=${String(code)} signal=${String(signal)}`);
  report(code, signal);
});

child.stdin?.write(frame({
  jsonrpc: "2.0",
  id: INIT_ID,
  method: "initialize",
  params: { clientInfo: { name: "oar-probe", version: "0.0.0" } },
}));
