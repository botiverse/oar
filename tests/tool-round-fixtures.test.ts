/* oxlint-disable eslint/max-statements -- Keep the two tool rounds and new-turn reset in one request sequence. */
import assert from "node:assert/strict";
import { LLMock } from "@copilotkit/aimock";
import { expect, test } from "vitest";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { toolRoundFixtures } from "../sea-trial/vendor/support/tool-round.js";

// Inject the native date refresh shape instead of waiting for a real UTC midnight.
const dateContext = (date: string, cwd = "/fixture") => ({
  type: "message", role: "user",
  content: [{ type: "input_text", text: `<environment_context>\n  <current_date>${date}</current_date>\n  <timezone>Etc/UTC</timezone>\n  <cwd>${cwd}</cwd>\n</environment_context>` }],
});
const prompt = { type: "message", role: "user", content: [{ type: "input_text", text: "please run the tool as instructed" }] };

async function request(mock: LLMock, input: readonly unknown[]) {
  const response = await fetch(`${mock.url}/v1/responses`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.1", input, stream: false }),
  });
  return { status: response.status, body: asRecord(await response.json()) };
}

async function completeTool(mock: LLMock, input: unknown[], marker: string): Promise<void> {
  const response = await request(mock, input);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ output: [{
    type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `echo ${marker}` }),
  }] });
  const output = response.body?.output;
  assert.ok(Array.isArray(output));
  const call = asRecord(output[0]);
  assert.ok(typeof call?.call_id === "string");
  input.push(call, { type: "function_call_output", call_id: call.call_id, output: marker });
}

async function withFixture(run: (mock: LLMock) => Promise<void>): Promise<void> {
  const mock = new LLMock({ port: 0 });
  toolRoundFixtures(mock, command => ({ name: "exec_command", arguments: JSON.stringify({ cmd: command }) }));
  await mock.start();
  try { await run(mock); } finally { await mock.stop(); }
}

test.each(["neither", "first", "second", "both"] as const)("tool round fixtures preserve both stages with date refresh placement: %s", async refresh => {
  await withFixture(async mock => {
    const input: unknown[] = [dateContext("2026-11-02"), prompt];
    await completeTool(mock, input, "oar-round-one");
    if (refresh === "first" || refresh === "both") { input.push(dateContext("2026-11-03")); }
    await completeTool(mock, input, "oar-round-two");
    if (refresh === "second" || refresh === "both") { input.push(dateContext("2026-11-03")); }
    const response = await request(mock, input);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ output: [{
      type: "message", role: "assistant", content: [{ type: "output_text", text: "both rounds done" }],
    }] });

    // A real new user turn must restart at round one despite earlier tool results.
    assert.ok(Array.isArray(response.body?.output));
    const output: readonly unknown[] = response.body.output;
    input.push(...output, prompt);
    await completeTool(mock, input, "oar-round-one");
  });
});

test("an unrelated latest tool result cannot borrow a marker from an older result or the date context", async () => {
  await withFixture(async mock => {
    const input: unknown[] = [prompt];
    await completeTool(mock, input, "oar-round-one");
    input.push({ type: "function_call_output", call_id: "different-tool", output: "unrelated result" },
      dateContext("2026-11-03", "/fixture/oar-round-two"));
    const response = await request(mock, input);
    expect(response.status).toBe(404);
  });
});
