/* oxlint-disable import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone Node child, outside the TypeScript project. */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [fixture, milliseconds, evidence] = process.argv.slice(2);
appendFileSync(evidence, `${JSON.stringify({ at: Date.now(), event: "wrapper_started", delayMs: Number(milliseconds), pid: process.pid })}\n`);
await delay(Number(milliseconds));
process.argv = [process.execPath, fixture, "--evidence", evidence];
await import(pathToFileURL(fixture).href);
