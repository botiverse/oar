import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { methods } from "../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { appRequestKind as rootAppRequestKind } from "../packages/oar/src/index.js";
import { appRequestKind } from "../packages/oar/src/observe/app-requests.js";
import { appRequestKind as observeAppRequestKind } from "../packages/oar/src/observe/index.js";
import { foldClaudeStdout, initialClaudeProjection } from "../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";

const kinds = (types: readonly string[]): Record<string, string> =>
  Object.fromEntries(types.map((type) => [type, appRequestKind(type)]));

test("appRequestKind is exported from the observe subpath and the root", () => {
  assert.equal(observeAppRequestKind, appRequestKind);
  assert.equal(rootAppRequestKind, appRequestKind);
});

test("appRequestKind classifies each runtime's request types", () => {
  expect({
    codex: kinds([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
    ]),
    claude: kinds(["can_use_tool", "elicitation"]),
    morph: kinds(["approval"]),
  }).toMatchInlineSnapshot(`
    {
      "claude": {
        "can_use_tool": "approval",
        "elicitation": "question",
      },
      "codex": {
        "item/commandExecution/requestApproval": "approval",
        "item/fileChange/requestApproval": "approval",
        "item/permissions/requestApproval": "approval",
        "item/tool/requestUserInput": "question",
        "mcpServer/elicitation/request": "question",
      },
      "morph": {
        "approval": "approval",
      },
    }
  `);
});

test("ACP: the SDK's client request methods (OAR's client app serves the permission and terminal ones)", () => {
  // shared/acp/client-app.ts registers these SDK constants; a renamed one shows up here.
  const { session, terminal, fs, elicitation } = methods.client;
  expect(kinds([
    session.requestPermission,
    ...Object.values(terminal),
    ...Object.values(fs),
    elicitation.create,
  ])).toMatchInlineSnapshot(`
    {
      "elicitation/create": "question",
      "fs/read_text_file": "service",
      "fs/write_text_file": "service",
      "session/request_permission": "approval",
      "terminal/create": "service",
      "terminal/kill": "service",
      "terminal/output": "service",
      "terminal/release": "service",
      "terminal/wait_for_exit": "service",
    }
  `);
});

test("every request a recorded ACP vendor run sent is classified", () => {
  const sent = ["kimi", "grok"].flatMap((name) => {
    const text = readFileSync(new URL(`replay/fixtures/${name}-acp-v1.vendor.json`, import.meta.url), "utf8");
    const prompt = asRecord(asRecord(parseJson(text))?.prompt);
    assert.ok(prompt, `${name}: a recorded prompt`);
    return [prompt.permissionRequests, prompt.terminalRequests]
      .flatMap((requests): unknown[] => (Array.isArray(requests) ? requests : []))
      .map((request) => String(asRecord(request)?.method));
  });
  expect(kinds(sent)).toMatchInlineSnapshot(`
    {
      "terminal/create": "service",
      "terminal/output": "service",
      "terminal/release": "service",
      "terminal/wait_for_exit": "service",
    }
  `);
});

test("claude records a control_request under its subtype, which classifies", () => {
  const recorded = ["can_use_tool", "elicitation"].flatMap((subtype) =>
    foldClaudeStdout(initialClaudeProjection, { type: "control_request", request_id: `req-${subtype}`, request: { subtype } })
      .commands.flatMap((command) => (command.kind === "toApp" ? [command.type] : [])));
  expect(kinds(recorded)).toMatchInlineSnapshot(`
    {
      "can_use_tool": "approval",
      "elicitation": "question",
    }
  `);
});

test("a type OAR does not recognise is unknown", () => {
  expect(kinds([
    // codex: a dynamic tool the app runs, an auth refresh, the v1-only approvals
    "item/tool/call",
    "account/chatgptAuthTokens/refresh",
    "execCommandApproval",
    "applyPatchApproval",
    // claude: subtypes that need a host to declare them first
    "hook_callback",
    "request_user_dialog",
    // no runtime's
    "fixture/reverse",
    "control_request",
    "",
    "toString",
    "__proto__",
  ])).toMatchInlineSnapshot(`
    {
      "": "unknown",
      "__proto__": "unknown",
      "account/chatgptAuthTokens/refresh": "unknown",
      "applyPatchApproval": "unknown",
      "control_request": "unknown",
      "execCommandApproval": "unknown",
      "fixture/reverse": "unknown",
      "hook_callback": "unknown",
      "item/tool/call": "unknown",
      "request_user_dialog": "unknown",
      "toString": "unknown",
    }
  `);
});
