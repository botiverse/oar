import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  grokAcpProfile,
  selectGrokAuthMethod,
} from "../../packages/oar/src/runtimes/grok/session.js";
import {
  kimiAcpProfile,
  selectKimiAuthMethod,
  supportsKimiYolo,
} from "../../packages/oar/src/runtimes/kimi/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

function record(value: unknown): JsonRecord {
  const result = asRecord(value);
  assert.ok(result);
  return result;
}

function strings(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  return value.filter((item): item is string => typeof item === "string");
}

function loadSnapshot(name: "grok" | "kimi"): JsonRecord {
  const text = readFileSync(new URL(`../replay/fixtures/${name}-acp-v1.vendor.json`, import.meta.url), "utf8");
  return record(parseJson(text));
}

function initializeResponse(snapshot: JsonRecord): JsonRecord {
  const initialize = record(snapshot.initialize);
  const methods = strings(initialize.authMethodIds).map((id) => ({ id }));
  const preferred = initialize.defaultAuthMethodId;
  return {
    authMethods: methods,
    ...(typeof preferred === "string" ? { _meta: { defaultAuthMethodId: preferred } } : {}),
  };
}

function sessionResponse(snapshot: JsonRecord): JsonRecord {
  const session = record(snapshot.sessionNew);
  const modeIds = strings(session.modeIds);
  return { modes: { availableModes: modeIds.map((id) => ({ id })) } };
}

function promptFacts(snapshot: JsonRecord): JsonRecord {
  const prompt = record(snapshot.prompt);
  const terminalRequests = Array.isArray(prompt.terminalRequests) ? prompt.terminalRequests : [];
  const tools = Array.isArray(prompt.tools) ? prompt.tools : [];
  return {
    stopReason: prompt.stopReason,
    terminalMethods: terminalRequests.map((item) => record(item).method),
    terminalCreateKeys: strings(record(terminalRequests[0]).paramKeys),
    finalToolStatus: record(tools.at(-1)).status,
  };
}

test("Grok ACP v1 snapshot remains compatible with its private profile", () => {
  const snapshot = loadSnapshot("grok");
  expect({
    runtime: snapshot.runtime,
    version: snapshot.version,
    auth: selectGrokAuthMethod(initializeResponse(snapshot)),
    shellCommandCompatibility: grokAcpProfile.terminalShellCommand,
    ...promptFacts(snapshot),
  }).toMatchInlineSnapshot(`
    {
      "auth": "cached_token",
      "finalToolStatus": "completed",
      "runtime": "grok",
      "shellCommandCompatibility": true,
      "stopReason": "end_turn",
      "terminalCreateKeys": [
        "command",
        "cwd",
        "env",
        "outputByteLimit",
        "sessionId",
      ],
      "terminalMethods": [
        "terminal/create",
        "terminal/wait_for_exit",
        "terminal/output",
        "terminal/release",
      ],
      "version": "grok 1.0.5 (5115b46bc9)",
    }
  `);
});

test("Kimi ACP v1 snapshot remains compatible with login and YOLO selection", () => {
  const snapshot = loadSnapshot("kimi");
  expect({
    runtime: snapshot.runtime,
    version: snapshot.version,
    auth: selectKimiAuthMethod(initializeResponse(snapshot)),
    shellCommandCompatibility: kimiAcpProfile.terminalShellCommand ?? false,
    yolo: supportsKimiYolo(sessionResponse(snapshot)),
    ...promptFacts(snapshot),
  }).toMatchInlineSnapshot(`
    {
      "auth": "login",
      "finalToolStatus": "completed",
      "runtime": "kimi",
      "shellCommandCompatibility": false,
      "stopReason": "end_turn",
      "terminalCreateKeys": [
        "args",
        "command",
        "cwd",
        "env",
        "outputByteLimit",
        "sessionId",
      ],
      "terminalMethods": [
        "terminal/create",
        "terminal/wait_for_exit",
        "terminal/output",
        "terminal/release",
      ],
      "version": "0.38.0",
      "yolo": true,
    }
  `);
});
