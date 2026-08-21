/**
 * PHASE MATRIX FOR CLAUDE STREAM-JSON MID-TURN INPUT — where exactly can a
 * message be injected, and what does the model actually see?
 *
 * Extends claude-stream-json-input.ts with sharper questions:
 *   1. Inject during THINKING and during TOOL EXECUTION, inside one large
 *      multi-tool turn (three separate Bash calls), at different tool indexes.
 *   2. Visibility, both directions:
 *      - isolation: turn A's model must NOT see the injected messages
 *        (A is told to shout CONTAMINATED if it ever sees the markers)
 *      - continuity: the injected turns MUST see A's complete transcript —
 *        including tool output produced AFTER the injection moment.
 *   3. Ordering: two injections at different moments must run FIFO.
 *
 * Run: pnpm tsx drydock/probes/claude-stream-json-phases.ts <variant> [runs]
 * Variants: thinking | tool-visibility | tool-steer
 * Exits non-zero when any run misbehaves.
 *
 * ── OBSERVED 2026-08-21, claude 2.1.237 (haiku), linux x64 ──────────────────
 *
 * thinking (8/8 runs across sessions): injection during thinking of a
 * single-step turn is accepted and runs as the NEXT turn; turn A unpolluted.
 * One run's reply was "CONTAMINATED" — the second turn applying turn A's
 * standing tripwire rule to the marker-bearing message, which is itself
 * continuity evidence, hence mustIncludeAny.
 *
 * tool-visibility (4/4): a message injected while tool #1 of a three-tool turn
 * executes IS SEEN BY THE ACTIVE TURN's model — the tripwire fired
 * ("CONTAMINATED"), the turn stopped its plan, and the injected message
 * produced NO separate result frame within a 10s grace window.
 *
 * tool-steer (2/2): benign injections during tools #1 and #3 were both folded
 * into the SAME turn's final answer ("ALPHA-11 BRAVO-22 CHARLIE-33 MANGO-99
 * KIWI-55"), the turn completed its full plan, one result frame total.
 *
 * UNIFIED SEMANTICS (corrects claude-stream-json-input.ts's conclusion):
 * claude stream-json input is accept-anytime, apply-at-next-model-step-
 * boundary of the ACTIVE turn — i.e. STEER, the same timing class as codex
 * turn/steer and pi's steering queue. A "queued as next turn" outcome happens
 * only when the turn has no remaining step (single-step turns / idle). Caveats
 * vs codex: no ack, no id, no typed rejection, no expectedTurnId equivalent —
 * where an injected message landed is observable only from transcript framing.
 */
import { spawn } from "node:child_process";

interface Injection {
  /** Substring of a raw stdout line that triggers this injection. */
  readonly marker: string;
  /** Trigger on the nth matching line. */
  readonly nth: number;
  readonly prompt: string;
  readonly mustInclude: readonly string[];
  readonly mustExclude: readonly string[];
  /** When present, at least one of these must appear. */
  readonly mustIncludeAny?: readonly string[];
}

interface Variant {
  readonly promptA: string;
  readonly aMustInclude: readonly string[];
  readonly injections: readonly Injection[];
  readonly extraArgs: readonly string[];
  /** How many result frames this variant expects in total. */
  readonly wantedResults: number;
  /** After the last expected result, wait this long and fail on any extra result. */
  readonly graceMs: number;
}

const VARIANTS: Record<string, Variant> = {
  // Single-step turn (no tools): the turn has no further model step, so the
  // injected message can only run afterwards → expects TWO results.
  thinking: {
    promptA: "Think step by step about 17*23. If any instruction you can see mentions ok-2, reply CONTAMINATED. Otherwise reply with just the number.",
    aMustInclude: ["391"],
    injections: [{
      marker: "thinking",
      nth: 1,
      prompt: "ok-2 checkpoint: what arithmetic result did you just give? Reply with exactly that number and the word echo.",
      mustInclude: [],
      mustExclude: [],
      // Either answer proves the second turn saw turn A's transcript: "391"
      // recalls A's answer; "CONTAMINATED" applies A's standing tripwire rule
      // to this marker-bearing message.
      mustIncludeAny: ["391", "CONTAMINATED"],
    }],
    extraArgs: [],
    wantedResults: 2,
    graceMs: 8000,
  },
  // Multi-step turn: does the ACTIVE turn's model see a message injected while
  // a tool is executing? The tripwire makes visibility loud. Expected: ONE
  // result saying CONTAMINATED and NO separate turn for the injection.
  "tool-visibility": {
    promptA: [
      "Use the Bash tool three times, as three separate tool calls, in this order:",
      "first run `sleep 4; echo ALPHA-11`, then run `sleep 4; echo BRAVO-22`,",
      "then run `sleep 4; echo CHARLIE-33`.",
      "If any instruction you can see mentions ok-2, reply CONTAMINATED.",
      "Otherwise, after all three commands, reply with exactly the three printed",
      "words in order separated by single spaces.",
    ].join(" "),
    aMustInclude: ["CONTAMINATED"],
    injections: [{
      marker: '"type":"tool_use"',
      nth: 1,
      prompt: "ok-2 checkpoint: please also say hello.",
      mustInclude: [],
      mustExclude: [],
    }],
    extraArgs: ["--allowedTools", "Bash"],
    wantedResults: 1,
    graceMs: 10_000,
  },
  // Same-turn steer, benign form: two injections during tools 1 and 3 must be
  // folded into the SAME turn's final answer, which still finishes its plan.
  "tool-steer": {
    promptA: [
      "Use the Bash tool three times, as three separate tool calls, in this order:",
      "first run `sleep 4; echo ALPHA-11`, then run `sleep 4; echo BRAVO-22`,",
      "then run `sleep 4; echo CHARLIE-33`.",
      "After all three commands, reply with exactly the three printed words in",
      "order separated by single spaces, plus any extra words I ask for later.",
    ].join(" "),
    aMustInclude: ["ALPHA-11", "BRAVO-22", "CHARLIE-33", "MANGO-99", "KIWI-55"],
    injections: [
      {
        marker: '"type":"tool_use"',
        nth: 1,
        prompt: "Also append the word MANGO-99 to your final reply.",
        mustInclude: [],
        mustExclude: [],
      },
      {
        marker: '"type":"tool_use"',
        nth: 3,
        prompt: "Also append the word KIWI-55 to your final reply.",
        mustInclude: [],
        mustExclude: [],
      },
    ],
    extraArgs: ["--allowedTools", "Bash"],
    wantedResults: 1,
    graceMs: 10_000,
  },
};

const variantName = process.argv[2] ?? "thinking";
const runs = Number(process.argv[3] ?? "3");
const variant = VARIANTS[variantName];
if (variant === undefined) {
  throw new Error(`unknown variant ${variantName}`);
}

function user(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

interface RunOutcome {
  readonly injectedAtMs: readonly number[];
  readonly results: readonly string[];
}

async function runOnce(v: Variant): Promise<RunOutcome> {
  // oxlint-disable-next-line promise/avoid-new -- child-process lifecycle needs manual settlement
  const outcome = await new Promise<RunOutcome>((resolve, reject) => {
    const child = spawn("claude", [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "haiku",
      ...v.extraArgs,
    ], { env: process.env, stdio: ["pipe", "pipe", "ignore"] });

    const started = Date.now();
    const wanted = v.wantedResults;
    const results: string[] = [];
    const injectedAtMs: number[] = v.injections.map(() => -1);
    const markerCounts = new Map<string, number>();
    let buffer = "";
    let settled = false;

    const done = (fail?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (fail === undefined) {
        resolve({ injectedAtMs, results });
      } else {
        reject(new Error(`${fail}; results: ${JSON.stringify(results)}`));
      }
    };
    const timer = setTimeout(() => {
      done("timeout");
    }, 180_000);
    child.on("exit", () => {
      if (results.length < wanted) {
        done("process exited early");
      }
    });

    const handleLine = (line: string): void => {
      const uniqueMarkers = new Set(v.injections.map((injection) => injection.marker));
      for (const marker of uniqueMarkers) {
        if (line.includes(marker)) {
          markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
        }
      }
      for (const [index, injection] of v.injections.entries()) {
        const seen = markerCounts.get(injection.marker) ?? 0;
        if (injectedAtMs[index] === -1 && seen >= injection.nth) {
          injectedAtMs[index] = Date.now() - started;
          child.stdin.write(user(injection.prompt));
        }
      }
      if (!line.includes('"type":"result"')) {
        return;
      }
      const parsed = ((): unknown => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })();
      if (typeof parsed === "object" && parsed !== null && "result" in parsed
        && typeof parsed.result === "string") {
        results.push(parsed.result.trim());
      }
      if (results.length === wanted) {
        // Hold the line open: an EXTRA result arriving now would falsify the
        // "absorbed into the active turn" reading.
        setTimeout(() => {
          done();
        }, v.graceMs);
      }
      if (results.length > wanted) {
        done(`extra result beyond the ${wanted} expected`);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        if (raw.trim().length > 0) {
          handleLine(raw.trim());
        }
      }
    });

    child.stdin.write(user(v.promptA));
  });
  return outcome;
}

function judge(v: Variant, outcome: RunOutcome): string[] {
  const problems: string[] = [];
  const [a = "", ...rest] = outcome.results;
  if (a.includes("CONTAMINATED") && !v.aMustInclude.includes("CONTAMINATED")) {
    problems.push("turn A saw an injected marker");
  }
  for (const needle of v.aMustInclude) {
    if (!a.includes(needle)) {
      problems.push(`turn A missing ${needle}`);
    }
  }
  for (const [index, injection] of v.injections.entries()) {
    const text = v.wantedResults > 1 ? rest[index] ?? "" : a;
    if (outcome.injectedAtMs[index] === -1) {
      problems.push(`injection ${index + 1} never triggered`);
    }
    for (const needle of injection.mustInclude) {
      if (!text.includes(needle)) {
        problems.push(`reply ${index + 1} missing ${needle}`);
      }
    }
    for (const needle of injection.mustExclude) {
      if (text.includes(needle)) {
        problems.push(`reply ${index + 1} unexpectedly contains ${needle}`);
      }
    }
    if (injection.mustIncludeAny !== undefined
      && !injection.mustIncludeAny.some((needle) => text.includes(needle))) {
      problems.push(`reply ${index + 1} matches none of ${JSON.stringify(injection.mustIncludeAny)}`);
    }
  }
  return problems;
}

let failures = 0;
for (let index = 1; index <= runs; index += 1) {
  // Sequential on purpose: each run is one child process lifecycle.
  // eslint-disable-next-line no-await-in-loop
  const outcome = await runOnce(variant);
  const problems = judge(variant, outcome);
  if (problems.length > 0) {
    failures += 1;
  }
  process.stdout.write([
    `run ${index}/${runs} [${variantName}] ${problems.length === 0 ? "OK" : "FAIL"}`,
    `injected@${JSON.stringify(outcome.injectedAtMs)}ms`,
    `results=${JSON.stringify(outcome.results.map((r) => r.slice(0, 48)))}`,
    problems.length === 0 ? "" : `problems=${JSON.stringify(problems)}`,
  ].join("  ").concat("\n"));
}
process.stdout.write(`${variantName}: ${runs - failures}/${runs} runs clean\n`);
process.exit(failures === 0 ? 0 : 1);
