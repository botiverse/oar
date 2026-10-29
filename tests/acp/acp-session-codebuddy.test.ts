import { expect, test } from "vitest";
import { codebuddyAcpProfile } from "../../packages/oar/src/runtimes/codebuddy/session.js";
import { codebuddyPromptOutcome } from "../../packages/oar/src/runtimes/codebuddy/failure.js";
import { projectCodebuddyModels } from "../../packages/oar/src/runtimes/codebuddy/list-models.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { fixture } from "../fixtures/acp-session-support.js";

// oxlint-disable-next-line eslint/max-statements -- One transcript checks context absence, a native zero report, and private extension redaction together.
test.each(["usage-never", "codebuddy-zero-context"])("CodeBuddy preserves absent context versus native 0/0: %s", async (mode) => {
  const session = await acpSession({ ...codebuddyAcpProfile, args: [fixture, mode] })(
    { kind: "available", via: "executable", command: process.execPath },
    { cwd: process.cwd() },
  );
  try {
    expect(session.contextUsage().value).toBeNull();
    const run = await promptAndWait(session, "one");
    expect(run.kind).toBe("ended");
    expect(session.contextUsage().value).toEqual(mode === "usage-never"
      ? null : { tokens: 0, contextWindow: 0, percent: null });
    expect(session.usage().value).toMatchInlineSnapshot(`
      {
        "total": null,
      }
    `);
    const frames = session.records().filter((record) => record.kind === "frame" && record.body.type === "usage_update");
    expect(frames).toHaveLength(mode === "usage-never" ? 0 : 1);
    expect(JSON.stringify(session.records())).not.toContain("private-browser-state");
    if (mode === "codebuddy-zero-context") {
      const extensions = session.records().flatMap((record) => record.kind === "frame" && record.body.type.startsWith("_codebuddy.ai/") ? [record.body.native] : []);
      expect(extensions).toMatchInlineSnapshot(`
        [
          {
            "authUrl": "[redacted]",
            "provider": "external",
          },
          {
            "action": "workspace_info",
            "params": {
              "isGitWorkspace": false,
            },
            "sessionId": "fake-session",
          },
        ]
      `);
    }
  } finally {
    await session.dispose();
  }
});

test("CodeBuddy preserves the native failure reason even in a successful prompt RPC", () => {
  expect(codebuddyPromptOutcome({ stopReason: "refusal", _meta: {
    "codebuddy.ai/outcome": "FAILED_MODEL_REQUEST",
    "codebuddy.ai/errorMessage": JSON.stringify({ data: { statusCode: 401 }, message: "native-provider-detail" }),
  } })).toMatchInlineSnapshot(`
    {
      "failure": "auth",
      "kind": "failed",
      "reason": "native-provider-detail",
      "status": 401,
    }
  `);
  expect(codebuddyPromptOutcome({ stopReason: "end_turn", _meta: { "codebuddy.ai/outcome": "FAILED_OTHER" } })).toMatchInlineSnapshot(`
    {
      "failure": "unknown",
      "kind": "failed",
      "reason": "FAILED_OTHER",
    }
  `);
  expect(codebuddyPromptOutcome({ stopReason: "cancelled" })).toEqual({ kind: "aborted" });
  expect(codebuddyPromptOutcome({ stopReason: "end_turn" })).toBeNull();
});

test.each(["FAILED_TOOL_EXECUTION", "FAILED_AGENT_LOOP"])("%s is not reported as a fabricated model refusal", (outcome) => {
  expect(codebuddyPromptOutcome({ stopReason: "end_turn", _meta: { "codebuddy.ai/outcome": outcome } })).toEqual({ kind: "failed", failure: "unknown", reason: outcome });
});

test.each([["quota", "quota"], ["auth", "auth"], ["custom_model_auth", "auth"], ["network", "unknown"], ["model_service", "provider"], ["empty_model_response", "provider"], ["internal", "unknown"]])("native %s precedes a conflicting HTTP status", (category, failure) => {
  for (const nested of [false, true]) {
    const error = { message: "Native category detail", data: { category, statusCode: 429 } };
    expect(codebuddyPromptOutcome({ stopReason: "refusal", _meta: {
      "codebuddy.ai/errorMessage": JSON.stringify(nested ? { error } : error),
    } })).toEqual({ kind: "failed", failure, status: 429, reason: "Native category detail" });
  }
});

test("CodeBuddy model entries only attach the current model's effort menu and omit on/off toggles", () => {
  expect(projectCodebuddyModels({ configOptions: [
    { id: "model", currentValue: "current", options: [{ value: "current", name: "Current" }, { value: "other", name: "other" }] },
    { id: "thought_level", category: "thought_level", currentValue: "high", options: [{ value: "disabled" }, { value: "enabled" }, { value: "high" }] },
  ] })).toMatchInlineSnapshot(`
    [
      {
        "default": true,
        "defaultEffort": "high",
        "displayName": "Current",
        "effortLevels": [
          "high",
        ],
        "id": "current",
      },
      {
        "id": "other",
      },
    ]
  `);
  expect(projectCodebuddyModels({})).toBeUndefined();
});
