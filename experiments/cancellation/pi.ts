/* eslint-disable no-underscore-dangle -- The probe deliberately supplies the SDK private receiver fields. */
// Calls installed SDK methods on an isolated in-memory test double. No session,
// provider, tools, extensions, configuration or credentials are initialized.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentSession } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";

const metadata: unknown = JSON.parse(readFileSync(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"));
assert.ok(typeof metadata === "object" && metadata !== null && "version" in metadata && typeof metadata.version === "string");
const { version } = metadata;
const calls: string[] = [];
const fake = {
  _steeringMessages: ["steer-a", "steer-a"],
  _followUpMessages: ["follow-up"],
  agent: {
    clearAllQueues(): void { calls.push("clearAllQueues"); },
    abort(): void { calls.push("abort"); },
  },
  _emitQueueUpdate(): void { calls.push("queue-update"); },
  abortRetry(): void { calls.push("abortRetry"); },
  async waitForIdle(): Promise<void> { calls.push("waitForIdle"); await Promise.resolve(); },
};
// eslint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the isolated receiver explicitly.
await Reflect.apply(AgentSession.prototype.abort, fake, []);
assert.deepEqual(fake._steeringMessages, ["steer-a", "steer-a"]);
assert.deepEqual(fake._followUpMessages, ["follow-up"]);
assert.deepEqual(calls, ["abortRetry", "abort", "waitForIdle"]);
// eslint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the isolated receiver explicitly.
const removed: unknown = Reflect.apply(AgentSession.prototype.clearQueue, fake, []);
assert.deepEqual(removed, { steering: ["steer-a", "steer-a"], followUp: ["follow-up"] });
assert.deepEqual(fake._steeringMessages, []);
assert.deepEqual(fake._followUpMessages, []);
assert.deepEqual(calls.slice(3), ["clearAllQueues", "queue-update"]);
process.stdout.write(`${JSON.stringify({version, mode: "installed SDK methods with mock receiver; no live turn", abortClearsQueues: false, clearQueueScope: "all steering and followUp", returnsRemovedMessages: true, preservesDuplicateEntries: true}, null, 2)}\n`);
