/**
 * REAL ACP WIRE SNAPSHOT RECORDER.
 *
 * Records only protocol structure and controlled tool labels/field names;
 * session ids, paths, prompts, output, account data, and credentials are
 * deliberately omitted. The checked-in fixtures were recorded with:
 *
 *   OAR_GROK_BIN=/path/to/grok GROK_HOME=/isolated/home pnpm tsx experiments/acp-vendor-snapshot.ts grok
 *   OAR_KIMI_BIN=/path/to/kimi KIMI_CODE_HOME=/isolated/home pnpm tsx experiments/acp-vendor-snapshot.ts kimi
 */
import assert from "node:assert/strict";
import { grokInstallation } from "../packages/oar/src/runtimes/grok/installation.js";
import { grokAcpProfile } from "../packages/oar/src/runtimes/grok/session.js";
import { kimiInstallation } from "../packages/oar/src/runtimes/kimi/installation.js";
import { kimiAcpProfile } from "../packages/oar/src/runtimes/kimi/session.js";
import { startAcpJsonRpcClient } from "../packages/oar/src/shared/acp/json-rpc.js";
import {
  defaultAcpReverseRequest,
  openAcpSession,
  type AcpSessionProfile,
} from "../packages/oar/src/shared/acp/profile.js";
import { createAcpTerminalHost } from "../packages/oar/src/shared/acp/terminal.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";

interface Target {
  readonly id: "grok" | "kimi";
  readonly installation: typeof grokInstallation;
  readonly profile: AcpSessionProfile;
}

const options = { cwd: process.cwd() };

function selectTarget(name: string | undefined): Target {
  if (name === "grok") {
    return { id: name, installation: grokInstallation, profile: grokAcpProfile };
  }
  if (name === "kimi") {
    return { id: name, installation: kimiInstallation, profile: kimiAcpProfile };
  }
  throw new Error("usage: tsx experiments/acp-vendor-snapshot.ts <grok|kimi>");
}

function ids(value: unknown, key: string): string[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => asRecord(item)?.[key])
    .filter((item): item is string => typeof item === "string");
}

function summarizeTool(update: JsonRecord): JsonRecord | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return null;
  }
  const rawInput = asRecord(update.rawInput);
  const rawOutput = asRecord(update.rawOutput);
  const contentTypes = (Array.isArray(update.content) ? update.content : [])
    .map((item) => asRecord(item)?.type)
    .filter((item): item is string => typeof item === "string");
  return {
    sessionUpdate: update.sessionUpdate,
    ...(typeof update.title === "string" ? { title: update.title } : {}),
    ...(typeof update.toolName === "string" ? { toolName: update.toolName } : {}),
    ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
    ...(typeof update.status === "string" ? { status: update.status } : {}),
    ...(rawInput === null ? {} : { rawInputKeys: Object.keys(rawInput).toSorted() }),
    ...(rawOutput === null ? {} : { rawOutputKeys: Object.keys(rawOutput).toSorted() }),
    ...(contentTypes.length === 0 ? {} : { contentTypes }),
    ...(update.rawOutput === undefined ? {} : { rawOutputType: typeof update.rawOutput }),
  };
}

const [name] = process.argv.slice(2);
const target = selectTarget(name);
const installation = await target.installation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const args = typeof target.profile.args === "function"
  ? target.profile.args(options)
  : target.profile.args;
const permissionRequests: JsonRecord[] = [];
const terminalRequests: JsonRecord[] = [];
const terminalHost = createAcpTerminalHost(options.cwd, process.env, {
  shellCommand: target.profile.terminalShellCommand === true,
});
const client = startAcpJsonRpcClient(installation.command, args, {
  cwd: options.cwd,
  env: process.env,
  requestTimeoutMs: 30_000,
  reverseRequest: (method, params): JsonRecord | Promise<JsonRecord> => {
    if (terminalHost.handles(method)) {
      terminalRequests.push({ method, paramKeys: Object.keys(params).toSorted() });
      return terminalHost.request(method, params);
    }
    permissionRequests.push({
      method,
      optionKinds: (Array.isArray(params.options) ? params.options : [])
        .map((item) => asRecord(item)?.kind)
        .filter((item): item is string => typeof item === "string"),
    });
    return defaultAcpReverseRequest(method, params);
  },
});
const tools: JsonRecord[] = [];
let lastToolSummary = "";
client.onNotification((method, params) => {
  if (method !== "session/update") {
    return;
  }
  const update = asRecord(params.update);
  const summary = update === null ? null : summarizeTool(update);
  if (summary !== null) {
    const serialized = JSON.stringify(summary);
    if (serialized !== lastToolSummary) {
      tools.push(summary);
      lastToolSummary = serialized;
    }
  }
});

try {
  const opened = await openAcpSession(client, target.profile, options);
  const result = await client.request("session/prompt", {
    sessionId: opened.sessionId,
    prompt: [{
      type: "text",
      text: "Use the shell tool to run `printf OAR_ACP_SNAPSHOT_OK`, then reply done.",
    }],
  }, { timeoutMs: null });
  const capabilities = asRecord(opened.initialized.agentCapabilities);
  const sessionCapabilities = asRecord(capabilities?.sessionCapabilities);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const initializeMeta = asRecord(opened.initialized._meta);
  const modes = asRecord(opened.response.modes);
  const models = asRecord(opened.response.models);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const promptMeta = asRecord(result._meta);
  process.stdout.write(`${JSON.stringify({
    runtime: target.id,
    observedAt: "2026-08-26",
    version: installation.version ?? null,
    initialize: {
      protocolVersion: opened.initialized.protocolVersion,
      authMethodIds: ids(opened.initialized.authMethods, "id"),
      ...(typeof initializeMeta?.defaultAuthMethodId === "string" ? {
        defaultAuthMethodId: initializeMeta.defaultAuthMethodId,
      } : {}),
      loadSession: capabilities?.loadSession === true,
      sessionCapabilities: Object.keys(sessionCapabilities ?? {}).toSorted(),
    },
    sessionNew: {
      configOptionIds: ids(opened.response.configOptions, "id"),
      modeIds: ids(modes?.availableModes, "id"),
      modelIds: ids(models?.availableModels, "modelId"),
    },
    prompt: {
      stopReason: result.stopReason,
      metaKeys: Object.keys(promptMeta ?? {}).toSorted(),
      permissionRequests,
      terminalRequests,
      tools,
    },
  }, null, 2)}\n`);
  if (sessionCapabilities?.close !== undefined) {
    await client.request("session/close", { sessionId: opened.sessionId }, { timeoutMs: 2000 });
  }
} finally {
  client.kill();
  await client.exited;
  await terminalHost.dispose();
}
