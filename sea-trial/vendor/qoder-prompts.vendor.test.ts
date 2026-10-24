import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { promptAndWait } from "../../packages/oar/src/index.js";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { qoderInstallation } from "../../packages/oar/src/runtimes/qoder/installation.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { qoderFixture } from "./support/qoder-fixture.js";

/** Exhausting the native replay reports the actual model request in its saved error. */
async function savedSystemPrompt(home: string, sessionId: string): Promise<string> {
  const projects = path.join(home, ".qoder", "projects");
  const files = await readdir(projects, { recursive: true });
  const file = files.find((entry) => path.basename(entry) === `${sessionId}.jsonl`);
  assert.ok(file !== undefined, "Qoder did not save the native conversation");
  const content = await readFile(path.join(projects, file), "utf8");
  const records = content.trim().split("\n").map((line) => asRecord(parseJson(line)));
  const error = records.findLast((record) => typeof record?.errorDetails === "string" && record.errorDetails.includes("No more mock responses for generateContentStream"));
  assert.ok(typeof error?.errorDetails === "string", "Qoder did not retain its exhausted-replay request");
  const requestLine = error.errorDetails.split("got request:\n")[1]?.split("\n")[0];
  assert.ok(requestLine !== undefined && requestLine !== "", error.errorDetails);
  const system = asRecord(asRecord(parseJson(requestLine))?.chatAsk)?.system;
  assert.ok(Array.isArray(system), requestLine);
  return system.map((block: unknown) => {
    const text = asRecord(block)?.text;
    assert.equal(typeof text, "string");
    return text;
  }).join("\n");
}

test.skipIf(process.env.OAR_TEST !== "qoder-native")("long private prompt files replace and append on native resume", async () => {
  const installation = await qoderInstallation();
  assert.ok(installation.kind === "available");
  const env = await qoderFixture([{ text: "saved" }]);
  const initial = await qoderSession(installation, { ...env.options, model: "efficient",
    systemPrompt: "OAR_OLD_SYSTEM", appendSystemPrompt: "OAR_OLD_APPEND" });
  try {
    const result = await promptAndWait(initial, "save this conversation", { timeoutMs: 30_000 });
    assert.ok(result.kind === "ended", JSON.stringify(result));
    expect(result.outcome).toEqual({ kind: "completed" });
  } finally { await initial.dispose(); }
  // The replay's deliberate failure snapshots input before any provider call.
  await writeFile(path.join(env.home, "responses.jsonl"), "");
  for (const option of ["systemPrompt", "appendSystemPrompt"] as const) {
    const prompt = `OAR_NEW_${option}\n${"long private prompt line\n".repeat(2000)}`;
    const resumed = await qoderSession(installation, { ...env.options, model: "efficient", resume: initial.id, [option]: prompt });
    try {
      const result = await promptAndWait(resumed, `capture ${option}`, { timeoutMs: 30_000 });
      assert.ok(result.kind === "ended", JSON.stringify(result));
      expect(result.outcome.kind).toBe("failed");
    } finally { await resumed.dispose(); }
    const system = await savedSystemPrompt(env.home, initial.id);
    expect(system).toContain(prompt.trimEnd());
    expect(system).not.toContain("OAR_OLD_SYSTEM");
    expect(system).not.toContain("OAR_OLD_APPEND");
  }
}, 120_000);
