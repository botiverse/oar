/* oxlint-disable import/max-dependencies -- Native bridge, durable log and provider evidence in one focused regression. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { dshRuntime } from "../../packages/oar/src/runtimes/dsh/index.js";
import { dshControl } from "../../packages/oar/src/runtimes/dsh/control.js";
import { dshEnvironment, launchDsh } from "../../packages/oar/src/runtimes/dsh/launch.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { resolveRunDir } from "../harness/trace.js";
import { dshEnabled, nativeShell, say, untilCount, withDshFixture } from "./support/dsh-fixture.js";
import { durableEvents, lastInput, toolResults, type ProviderRequest } from "./support/dsh-provider.js";

import { promptKeys, promptSemantics, resumedMarker, type PromptKey } from "./support/resumed-prompts.js";

const REPLACE = "OAR replacement {{literal}}";
const APPEND = "OAR appended {{not_a_variable}}";

function nativeSystem(events: readonly JsonRecord[]): readonly string[] {
  return events.filter((event) => event.type === "system/message").map((event) =>
    asRecordList(asRecord(asRecord(event.data)?.message)?.content).map((block) => String(block.text)).join(""));
}

function wireSystem(request: ProviderRequest | undefined): string {
  assert.ok(request !== undefined);
  return request.messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => String(message.content)).join("\n\n");
}

const cases: readonly { readonly name: string; readonly options: Partial<Record<PromptKey, string>>; readonly expected: string }[] = [
  { name: "replacement", options: { systemPrompt: REPLACE }, expected: REPLACE },
  { name: "append", options: { appendSystemPrompt: APPEND }, expected: APPEND },
  { name: "both", options: { systemPrompt: REPLACE, appendSystemPrompt: APPEND }, expected: `${REPLACE}\n\n${APPEND}` },
];

describe.skipIf(!dshEnabled)("DSH scoped system prompts", () => {
  test.each(cases)("$name is literal at first turn and resume; omission returns to native defaults", async ({ name, options, expected }) => {
    await withDshFixture(() => say("ok"), async ({ open, aimock, provider }) => {
      const first = await open(options);
      const started = await first.prompt("first");
      expect(await awaitTurnEnd(first, started.seq)).toEqual({ kind: "completed" });
      await first.dispose();
      const firstLog = nativeSystem(await durableEvents(aimock.home, first.id));
      if (name === "append") {
        expect(firstLog[0]).toContain(APPEND);
        expect(firstLog[0]?.endsWith(APPEND)).toBe(true);
        expect(firstLog[0]?.length).toBeGreaterThan(APPEND.length);
      } else { expect(firstLog).toEqual([expected]); }
      expect(wireSystem(provider.requests[0])).toBe(firstLog[0]);

      const changed: Partial<Record<PromptKey, string>> = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, `${value} RESUMED`]));
      const resumed = await open({ ...changed, resume: first.id });
      const next = await resumed.prompt("second");
      expect(await awaitTurnEnd(resumed, next.seq)).toEqual({ kind: "completed" });
      await resumed.dispose();
      const resumedLog = nativeSystem(await durableEvents(aimock.home, first.id));
      const changedExpected = promptKeys.flatMap((key) => resumedMarker(promptSemantics(dshRuntime, key), { saved: options[key], provided: changed[key] }, false)).join("\n\n");
      if (name === "append") { expect(resumedLog.at(-1)?.endsWith(changedExpected)).toBe(true); }
      else { expect(resumedLog.at(-1)).toBe(changedExpected); }
      expect(wireSystem(provider.requests[1])).toBe(resumedLog.at(-1));

      const omitted = await open({ resume: first.id });
      const last = await omitted.prompt("third");
      expect(await awaitTurnEnd(omitted, last.seq)).toEqual({ kind: "completed" });
      await omitted.dispose();
      const finalLog = nativeSystem(await durableEvents(aimock.home, first.id));
      for (const key of promptKeys) {
        const saved = changed[key];
        if (saved === undefined) { continue; }
        const retained = resumedMarker(promptSemantics(dshRuntime, key), { saved, provided: undefined }, false);
        expect(finalLog.at(-1)?.includes(saved)).toBe(retained.includes(saved));
      }
      expect(wireSystem(provider.requests[2])).toBe(finalLog.at(-1));
      await writeFile(path.join(resolveRunDir(), `dsh-prompt-${name}.json`), JSON.stringify({ firstLog, resumedLog, finalLog, requests: provider.requests }, null, 2));
    });
  }, 90_000);

  test("one setup applies prompt and tool denial together, while resume preserves the native title", async () => {
    await withDshFixture(() => say("ok"), async ({ open, aimock, provider }) => {
      const options = { name: "Combined setup", systemPrompt: REPLACE, appendSystemPrompt: APPEND, disallowedTools: [nativeShell.tool] };
      const first = await open(options);
      const started = await first.prompt("COMBINED_FIRST");
      expect(await awaitTurnEnd(first, started.seq)).toEqual({ kind: "completed" });
      await first.dispose();
      const resumed = await open({ ...options, resume: first.id, name: "Preserve the first name" });
      const next = await resumed.prompt("COMBINED_RESUMED");
      expect(await awaitTurnEnd(resumed, next.seq)).toEqual({ kind: "completed" });
      await resumed.dispose();
      expect(provider.requests).toHaveLength(2);
      for (const request of provider.requests) {
        expect(wireSystem(request)).toBe(`${REPLACE}\n\n${APPEND}`);
        expect(JSON.stringify(request.body.tools)).not.toContain(`"name":"${nativeShell.tool}"`);
      }
      const log = await durableEvents(aimock.home, first.id);
      expect(log.filter((event) => event.type === "session/title").map((event) => event.data))
        .toEqual([expect.objectContaining({ title: "Combined setup", source: { kind: "user" } })]);
      await writeFile(path.join(resolveRunDir(), "dsh-prompt-combined-setup.json"), JSON.stringify({ log, requests: provider.requests }, null, 2));
    });
  }, 60_000);

  test("a creation hook's queued input sees the prompt before the open or resume returns", async () => {
    await withDshFixture(() => say("automatic reply"), async ({ aimock, open, provider }) => {
      const plugin = path.join(aimock.cwd, "queue-on-created.mjs");
      await writeFile(plugin, `export function apply(ctx) {
        ctx.on("agent/created", ({ agent }) => {
          agent.followup({ id: crypto.randomUUID(), role: "user", content: [{ type: "text", text: "AUTO_INPUT" }], source: { kind: "user" } });
        });
      }`);
      const patch = path.join(aimock.home, "cordis.patch.yml");
      const rows: unknown = JSON.parse(await readFile(patch, "utf8"));
      assert.ok(Array.isArray(rows));
      await writeFile(patch, JSON.stringify([...asRecordList(rows), { insert: [{ id: "queue-on-created", name: pathToFileURL(plugin).href }] }]));
      const first = await open({ systemPrompt: REPLACE });
      await untilCount(() => provider.requests.length, 1);
      expect(wireSystem(provider.requests[0])).toBe(REPLACE);
      await first.dispose();
      const resumed = await open({ resume: first.id, systemPrompt: `${REPLACE} RESUMED` });
      await untilCount(() => provider.requests.length, 2);
      expect(wireSystem(provider.requests[1])).toBe(`${REPLACE} RESUMED`);
      await resumed.dispose();
      const log = nativeSystem(await durableEvents(aimock.home, first.id));
      expect(log).toEqual([REPLACE, `${REPLACE} RESUMED`]);
      await writeFile(path.join(resolveRunDir(), "dsh-prompt-creation-hook.json"), JSON.stringify({ log, requests: provider.requests }, null, 2));
    });
  }, 60_000);

  test.each(["systemPrompt", "appendSystemPrompt"] as const)("a conflicting native complete section refuses %s before a provider call", async (option) => {
    await withDshFixture(() => say("must not run"), async ({ aimock, open, provider }) => {
      const plugin = path.join(aimock.cwd, "complete-prompt.mjs");
      await writeFile(plugin, `export const inject = ["systemPrompt"]; export function apply(ctx) {
        ctx.systemPrompt.section({ name: "fixture:complete", order: 0, text: "Native complete persona", complete: true });
      }`);
      const patch = path.join(aimock.home, "cordis.patch.yml");
      const rows: unknown = JSON.parse(await readFile(patch, "utf8"));
      assert.ok(Array.isArray(rows));
      await writeFile(patch, JSON.stringify([...asRecordList(rows), { insert: [{ id: "complete-prompt", name: pathToFileURL(plugin).href }] }]));
      const failure = await open({ [option]: APPEND }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UnsupportedOptionError);
      expect(failure).toMatchObject({ option });
      expect(provider.requests).toEqual([]);
      await writeFile(path.join(resolveRunDir(), `dsh-prompt-conflict-${option}.json`), JSON.stringify({ option, message: String(failure), providerRequests: provider.requests.length }, null, 2));
    });
  }, 60_000);

  test.each(["systemPrompt", "appendSystemPrompt"] as const)("a creation hook's complete section and queued input refuse %s before running", async (option) => {
    await withDshFixture(() => say("must not run"), async ({ aimock, open, provider }) => {
      const plugin = path.join(aimock.cwd, "created-complete.mjs");
      await writeFile(plugin, `export function apply(ctx) {
        ctx.on("agent/created", ({ agent }) => {
          agent.scope.ctx.systemPrompt.section({ name: "fixture:created-complete", order: 0, text: "Created complete persona", complete: true });
          agent.followup({ id: crypto.randomUUID(), role: "user", content: [{ type: "text", text: "MUST_NOT_RUN" }], source: { kind: "user" } });
        });
      }`);
      const patch = path.join(aimock.home, "cordis.patch.yml");
      const rows: unknown = JSON.parse(await readFile(patch, "utf8"));
      assert.ok(Array.isArray(rows));
      await writeFile(patch, JSON.stringify([...asRecordList(rows), { insert: [{ id: "created-complete", name: pathToFileURL(plugin).href }] }]));
      const failure = await open({ [option]: APPEND }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UnsupportedOptionError);
      expect(failure).toMatchObject({ option });
      expect(provider.requests).toEqual([]);
      await writeFile(path.join(resolveRunDir(), `dsh-prompt-created-conflict-${option}.json`), JSON.stringify({ option, message: String(failure), providerRequests: provider.requests.length }, null, 2));
    });
  }, 60_000);

  test("two agents in one bridge process keep their own prompts; a native child uses its own default prompt", async () => {
    await withDshFixture((request) => {
      if (lastInput(request).includes("CHILD_PROMPT")) { return say("child done"); }
      if (lastInput(request).includes("PARENT_PROMPT") && toolResults(request) === 0) {
        return { kind: "tool", name: "subagent", arguments: { description: "prompt inheritance", prompt: "CHILD_PROMPT" } };
      }
      return say("done");
    }, async ({ installation, aimock, provider }) => {
      assert.ok(installation.via === "executable");
      const { child, directory } = await launchDsh(installation.command, aimock.cwd, dshEnvironment(aimock.env));
      const frames: JsonRecord[] = [];
      const control = dshControl(child, (frame) => { frames.push(frame); });
      const ends = (id: string): number => frames.filter((frame) => frame.sessionId === id && asRecord(frame.event)?.type === "turn/end").length;
      try {
        await control.ready;
        await control.request("open", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: aimock.cwd, systemPrompt: REPLACE });
        await control.request("open", { sessionId: "22222222-2222-4222-8222-222222222222", cwd: aimock.cwd });
        await control.request("prompt", { sessionId: "22222222-2222-4222-8222-222222222222", text: "SIBLING_PROMPT" });
        await untilCount(() => ends("22222222-2222-4222-8222-222222222222"), 1);
        expect(ends("22222222-2222-4222-8222-222222222222")).toBe(1);
        expect(wireSystem(provider.requests[0])).not.toContain(REPLACE);
        await control.request("prompt", { sessionId: "11111111-1111-4111-8111-111111111111", text: "PARENT_PROMPT" });
        await untilCount(() => frames.filter((frame) => frame.channel === "subagent/end").length, 1);
        expect(frames.some((frame) => frame.channel === "subagent/end")).toBe(true);
        const childRequest = provider.requests.find((request) => lastInput(request).includes("CHILD_PROMPT"));
        expect(wireSystem(childRequest)).not.toContain(REPLACE);
        expect(wireSystem(childRequest).length).toBeGreaterThan(0);
        const parentRequest = provider.requests.find((request) => lastInput(request).includes("PARENT_PROMPT"));
        expect(wireSystem(parentRequest)).toBe(REPLACE);
        await control.request("dispose");
        const parentLog = nativeSystem(await durableEvents(aimock.home, "11111111-1111-4111-8111-111111111111"));
        const siblingLog = nativeSystem(await durableEvents(aimock.home, "22222222-2222-4222-8222-222222222222"));
        expect(parentLog.length).toBeGreaterThan(0);
        expect(parentLog.every((text) => text === REPLACE)).toBe(true);
        expect(siblingLog.every((text) => !text.includes(REPLACE))).toBe(true);
        await writeFile(path.join(resolveRunDir(), "dsh-prompt-scopes.json"), JSON.stringify({ parentLog, siblingLog, requests: provider.requests, frames }, null, 2));
      } finally { child.kill(); await child.exited; directory.remove(); }
    });
  }, 90_000);
});
