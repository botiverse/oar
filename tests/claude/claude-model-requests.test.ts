import { appendFile, writeFile, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { claudeModelRequestRefusal, verifyClaudeModelRequestSetting } from "../../packages/oar/src/runtimes/claude/options.js";
import { claudeModelRequests, type ClaudeModelRequests } from "../../packages/oar/src/runtimes/claude/model-requests.js";

async function fixture(): Promise<{ capture: ClaudeModelRequests; path: string }> {
  const capture = await claudeModelRequests("root", 100);
  onTestFinished(capture.remove);
  return { capture, path: capture.setting.slice("file:".length) };
}
function assistant(id: string): Record<string, unknown> {
  return { type: "assistant", session_id: "root", parent_tool_use_id: null, message: { id } };
}
function row(id: string, source = "sdk"): Record<string, string> {
  return { message_id: id, query_source: source, session_id: "root", request_file: `${id}.request.json`, response_file: `${id}.response.json` };
}
async function add(path: string, line: Record<string, unknown>): Promise<void> {
  await appendFile(join(path, "index.jsonl"), `${JSON.stringify(line)}\n`);
}

test("an aborted turn releases only its own missing attributions", async () => {
  const { capture } = await fixture();
  capture.observe(assistant("first"));
  capture.ended({ kind: "completed" });
  capture.observe(assistant("second"));
  capture.ended({ kind: "aborted" });
  await expect(capture.read()).rejects.toThrow("attributed root model request");
});

test("an incomplete index line and body are read only after both writes complete", async () => {
  const { capture, path } = await fixture();
  capture.observe(assistant("new"));
  const file = join(path, "new.request.json");
  await writeFile(file, '{"model":');
  await appendFile(join(path, "index.jsonl"), JSON.stringify(row("new")));
  const pending = capture.read();
  await appendFile(join(path, "index.jsonl"), "\n");
  await appendFile(file, '"model"}');
  expect(await pending).toMatchObject({ format: "anthropic.messages", model: "model", body: { model: "model" } });
});

test("a later attributed reply supersedes an older missing attribution", async () => {
  const { capture, path } = await fixture();
  capture.observe(assistant("missing"));
  capture.observe(assistant("new"));
  await writeFile(join(path, "new.request.json"), '{"model":"current"}');
  await add(path, row("new"));
  expect(await capture.read()).toMatchObject({ model: "current" });
  capture.observe(assistant("abort"));
  const reading = capture.read();
  capture.ended({ kind: "aborted" });
  expect(await reading).toMatchObject({ model: "current" });
});

test("synthetic and child frames never arm waits, and dispose wins over a pending read", async () => {
  const { capture } = await fixture();
  capture.observe({ ...assistant("error"), is_api_error_message: true });
  capture.observe({ ...assistant("subagent"), parent_tool_use_id: "task" });
  expect(await capture.read()).toBeNull();
  capture.observe(assistant("never"));
  const disposing = capture.read();
  capture.close();
  expect(await disposing).toBeNull();
  expect(await capture.read()).toBeNull();
});

test("the latest capture reports native omissions and removes retired and auxiliary files without disturbing in-flight requests", async () => {
  const { capture, path } = await fixture();
  const body = JSON.stringify({ messages: [{ content: [{ type: "thinking", thinking: "<REDACTED>" }] }] });
  await Promise.all(["old", "main", "sub", "future"].map(async (id) => { await writeFile(join(path, `${id}.request.json`), body); }));
  await utimes(join(path, "old.request.json"), 100, 100);
  await utimes(join(path, "future.request.json"), 4_000_000_000, 4_000_000_000);
  await add(path, row("sub", "compact"));
  await add(path, row("main"));
  expect(await capture.read()).toMatchObject({ withheld: ["thinking"] });
  const remaining = await readdir(path);
  expect(remaining.toSorted()).toEqual(["future.request.json", "index.jsonl", "main.request.json"]);
});

test("whole-body and missing-body attributions have a timestamp and no body", async () => {
  const { capture, path } = await fixture();
  await writeFile(join(path, "withheld.request.json"), JSON.stringify({ not_recorded: "memory" }));
  await add(path, row("withheld"));
  const withheld = await capture.read();
  expect(withheld?.at).toEqual(expect.any(String));
  expect(withheld?.withheld).toEqual(["body"]);
  expect(withheld).not.toHaveProperty("body");
});

test("a missing request uses the native response timestamp and model", async () => {
  const { capture, path } = await fixture();
  await writeFile(join(path, "missing.response.json"), JSON.stringify({ model: "native-model" }));
  await add(path, { ...row("missing"), request_file: null });
  const missing = await capture.read();
  expect(missing?.at).toEqual(expect.any(String));
  expect(missing).toMatchObject({ format: "anthropic.messages", model: "native-model", withheld: ["not_captured"] });
  expect(missing).not.toHaveProperty("body");
});

test("a late older index line preserves the newer attribution", async () => {
  const { capture, path } = await fixture();
  capture.observe(assistant("old"));
  capture.observe(assistant("current"));
  await writeFile(join(path, "current.request.json"), '{"model":"current"}');
  await add(path, { ...row("current"), timestamp: "2026-11-20T00:00:02Z" });
  expect(await capture.read()).toMatchObject({ model: "current" });
  await add(path, { ...row("old"), timestamp: "2026-11-20T00:00:01Z" });
  expect(await capture.read()).toMatchObject({ model: "current" });

});

test("a duplicate block of the kept response cannot clear a newer wait", async () => {
  const { capture, path } = await fixture();
  capture.observe(assistant("current"));
  await writeFile(join(path, "current.request.json"), '{"model":"current"}');
  await add(path, row("current"));
  expect(await capture.read()).toMatchObject({ model: "current" });
  capture.observe(assistant("new"));
  capture.observe(assistant("current"));
  await expect(capture.read()).rejects.toThrow("attributed root model request");
});

test("the first linked-index version supports capture and earlier or unreadable versions refuse", () => {
  for (const version of [undefined, "unknown", "2.1.273", "2.1.274-rc.1"]) {
    expect(claudeModelRequestRefusal(version).modelRequests).toContain("2.1.274");
  }
  expect(claudeModelRequestRefusal("2.1.274 (Claude Code)").modelRequests).toBeUndefined();
});

test("an overridden capture setting reports only the native source", () => {
  const env = { OTEL_LOG_RAW_API_BODIES: "private setting" };
  const settings = { effective: { env }, sources: [{ source: "policySettings", settings: { env } }] };
  expect(() => { verifyClaudeModelRequestSetting(settings, "expected"); }).toThrow(/source: policySettings\)/u);
  expect(() => { verifyClaudeModelRequestSetting(settings, "expected"); }).not.toThrow(/private setting/u);
  expect(() => { verifyClaudeModelRequestSetting(settings, env.OTEL_LOG_RAW_API_BODIES); }).not.toThrow();
});
