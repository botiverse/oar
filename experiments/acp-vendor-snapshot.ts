/* oxlint-disable typescript/promise-function-async -- SDK handlers deliberately return terminal promises directly. */
/* oxlint-disable import/max-dependencies -- the `files` scenario's scratch directory (fs, os, path) sits beside the ACP plumbing. */
/**
 * REAL ACP WIRE SNAPSHOT RECORDER.
 *
 * Records only protocol structure and controlled tool labels/field names;
 * session ids, paths, prompts, output, account data, and credentials are
 * deliberately omitted. The checked-in fixtures were recorded with:
 *
 *   OAR_GROK_BIN=/path/to/grok GROK_HOME=/isolated/home pnpm tsx experiments/acp-vendor-snapshot.ts grok
 *   OAR_KIMI_BIN=/path/to/kimi KIMI_CODE_HOME=/isolated/home pnpm tsx experiments/acp-vendor-snapshot.ts kimi
 *   OAR_OPENCODE_BIN=/path/to/opencode pnpm tsx experiments/acp-vendor-snapshot.ts opencode
 *
 * kimi re-checked live 2026-09-18 at 2.0.0: identical in structure to the
 * checked-in 0.38.0 fixture; the fixture was not refreshed.
 *
 * A second argument `files` asks for the file tools instead of one shell call
 * (write, read, edit, grep, glob, then a shell `cat`), run in a fresh scratch
 * directory whose path is replaced by `<cwd>` in the titles:
 *
 *   pnpm tsx experiments/acp-vendor-snapshot.ts opencode files > tests/replay/fixtures/opencode-acp-files.vendor.json
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grokInstallation, kimiInstallation, opencodeInstallation } from "../packages/oar/src/index.js";
import { grokAcpProfile } from "../packages/oar/src/runtimes/grok/session.js";
import { kimiAcpProfile } from "../packages/oar/src/runtimes/kimi/session.js";
import { opencodeAcpProfile } from "../packages/oar/src/runtimes/opencode/session.js";
import {
  closeAcpSession,
  openAcpSession,
  promptAcp,
  type AcpSessionProfile,
} from "../packages/oar/src/shared/acp/profile.js";
import {
  createAcpClient,
  methods,
  startAcpProcess,
} from "../packages/oar/src/shared/acp/process.js";
import { createAcpTerminalHost } from "../packages/oar/src/shared/acp/terminal.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";

interface Target {
  readonly id: "grok" | "kimi" | "opencode";
  readonly installation: typeof grokInstallation;
  readonly profile: AcpSessionProfile;
  readonly observedAt: string;
}

const SCENARIOS = {
  shell: { prompt: "Use the shell tool to run `printf OAR_ACP_SNAPSHOT_OK`, then reply done.", observedAt: null },
  files: {
    prompt: [
      "In the current directory, one tool call per step:",
      "use the write tool to create note.txt containing `hi`;",
      "use the read tool to read note.txt;",
      "use the edit tool to change `hi` to `hello` in note.txt;",
      "use the grep tool to search for `hello`;",
      "use the glob tool to find `*.txt`;",
      "use the shell tool to run `cat note.txt`;",
      "then reply done.",
    ].join(" "),
    observedAt: "2026-10-06",
  },
} as const;

const [runtimeName, scenarioName = "shell"] = process.argv.slice(2);
assert.ok(scenarioName === "shell" || scenarioName === "files", "usage: tsx experiments/acp-vendor-snapshot.ts <grok|kimi|opencode> [shell|files]");
const scenario = SCENARIOS[scenarioName];
const scratch = scenarioName === "files" ? mkdtempSync(path.join(tmpdir(), "oar-snapshot-")) : null;
const options = { cwd: scratch ?? process.cwd() };

function selectTarget(name: string | undefined): Target {
  if (name === "grok") {
    return { id: name, installation: grokInstallation, profile: grokAcpProfile, observedAt: "2026-08-26" };
  }
  if (name === "kimi") {
    return { id: name, installation: kimiInstallation, profile: kimiAcpProfile, observedAt: "2026-08-26" };
  }
  if (name === "opencode") {
    return { id: name, installation: opencodeInstallation, profile: opencodeAcpProfile, observedAt: "2026-10-05" };
  }
  throw new Error("usage: tsx experiments/acp-vendor-snapshot.ts <grok|kimi|opencode>");
}

function ids(value: unknown, key: string): string[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => asRecord(item)?.[key])
    .filter((item): item is string => typeof item === "string");
}

/** A title with the scratch directory (opencode titles a finished file call with its path, leading slash dropped) as `<cwd>`. */
function scrubbed(title: string): string {
  return scratch === null ? title : title.replaceAll(scratch, "<cwd>").replaceAll(scratch.replace(/^\//u, ""), "<cwd>");
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
    ...(typeof update.title === "string" ? { title: scrubbed(update.title) } : {}),
    ...(typeof update.toolName === "string" ? { toolName: update.toolName } : {}),
    ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
    ...(typeof update.status === "string" ? { status: update.status } : {}),
    ...(rawInput === null ? {} : { rawInputKeys: Object.keys(rawInput).toSorted() }),
    ...(rawOutput === null ? {} : { rawOutputKeys: Object.keys(rawOutput).toSorted() }),
    ...(contentTypes.length === 0 ? {} : { contentTypes }),
    ...(update.rawOutput === undefined ? {} : { rawOutputType: typeof update.rawOutput }),
  };
}

const target = selectTarget(runtimeName);
const installation = await target.installation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const args = typeof target.profile.args === "function"
  ? target.profile.args(options)
  : target.profile.args;
const permissionRequests: JsonRecord[] = [];
const terminalRequests: JsonRecord[] = [];
const tools: JsonRecord[] = [];
let lastToolSummary = "";
const terminalHost = createAcpTerminalHost(options.cwd, process.env, {
  shellCommand: target.profile.terminalShellCommand === true,
});
const observeTerminal = (method: string, params: object): void => {
  terminalRequests.push({ method, paramKeys: Object.keys(params).toSorted() });
};
const app = createAcpClient({ name: "oar-snapshot" })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    permissionRequests.push({
      method: methods.client.session.requestPermission,
      optionKinds: params.options.map(({ kind }) => kind),
    });
    const selected = params.options.find(({ kind }) => kind === "allow_always")
      ?? params.options.find(({ kind }) => kind === "allow_once");
    return selected === undefined
      ? { outcome: { outcome: "cancelled" as const } }
      : { outcome: { outcome: "selected" as const, optionId: selected.optionId } };
  })
  .onRequest(methods.client.terminal.create, ({ params }) => {
    observeTerminal(methods.client.terminal.create, params);
    return terminalHost.create(params);
  })
  .onRequest(methods.client.terminal.output, ({ params }) => {
    observeTerminal(methods.client.terminal.output, params);
    return terminalHost.output(params);
  })
  .onRequest(methods.client.terminal.waitForExit, ({ params }) => {
    observeTerminal(methods.client.terminal.waitForExit, params);
    return terminalHost.waitForExit(params);
  })
  .onRequest(methods.client.terminal.kill, ({ params }) => {
    observeTerminal(methods.client.terminal.kill, params);
    return terminalHost.kill(params);
  })
  .onRequest(methods.client.terminal.release, ({ params }) => {
    observeTerminal(methods.client.terminal.release, params);
    return terminalHost.release(params);
  })
  .onNotification(methods.client.session.update, ({ params }) => {
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
const runtime = startAcpProcess(installation.command, args, app, {
  cwd: options.cwd,
  env: process.env,
});

try {
  const opened = await openAcpSession(runtime, target.profile, options);
  const result = await promptAcp(
    runtime,
    opened.sessionId,
    [{ type: "text", text: scenario.prompt }],
  );
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
    ...(scenarioName === "shell" ? {} : { scenario: scenarioName }),
    observedAt: scenario.observedAt ?? target.observedAt,
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
    await closeAcpSession(runtime, opened.sessionId);
  }
} finally {
  runtime.kill();
  await runtime.exited;
  await terminalHost.dispose();
  if (scratch !== null) {
    rmSync(scratch, { recursive: true, force: true });
  }
}
