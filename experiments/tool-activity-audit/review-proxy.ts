#!/usr/bin/env node
// Probe only: OAR has no review/start API. Replace the first turn/start on
// the wire and forward every native response and notification unchanged.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const command = process.env.AUDIT_CODEX; const journal = process.env.AUDIT_WIRE;
assert.ok(command !== undefined && journal !== undefined);
const child = spawn(command, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
let reviewRequest: unknown = null;
let reviewTurn: unknown = null;
const log = (direction: string, message: unknown): void => { appendFileSync(journal, `${JSON.stringify({ direction, message })}\n`); };
createInterface({ input: process.stdin }).on("line", line => {
  const message: unknown = JSON.parse(line);
  assert.ok(record(message));
  const params = record(message.params) ? message.params : {};
  if (reviewRequest === null && message.method === "turn/start") {
    reviewRequest = message.id;
    message.method = "review/start";
    message.params = { threadId: params.threadId, target: { type: "custom", instructions: "AUDIT_REVIEW" }, delivery: "inline" };
  }
  if (process.env.AUDIT_MATCH_REVIEW === "1" && message.method === "turn/steer" && JSON.stringify(params.input).includes("STEER_review")) {
    params.expectedTurnId = reviewTurn;
  }
  log("toNative", message);
  child.stdin.write(`${JSON.stringify(message)}\n`);
}).on("close", () => { child.stdin.end(); });
createInterface({ input: child.stdout }).on("line", line => {
  const message: unknown = JSON.parse(line);
  assert.ok(record(message));
  const result = record(message.result) ? message.result : {};
  if (message.id === reviewRequest && record(result.turn)) { reviewTurn = result.turn.id; }
  log("fromNative", message);
  process.stdout.write(`${line}\n`);
});
child.on("exit", code => { process.exitCode = code ?? 1; });
