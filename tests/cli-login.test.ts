import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { PassThrough } from "node:stream";
import {
  loginExitCode,
  readAuthStatus,
  renderAuthStatus,
  renderLoginReport,
  runLogin,
} from "../packages/cli/src/login.js";
import { EchoGate, hidesInput, renderLoginEvent, selectAnswer } from "../packages/cli/src/login-terminal.js";

// The CLI resolves `@botiverse/oar` to the built package, so fixtures take
// their shapes from the CLI functions under test.
type Runtime = Parameters<typeof runLogin>[0];
type Interaction = Parameters<typeof runLogin>[1];
type AvailableInstallation = Parameters<NonNullable<Runtime["login"]>>[0];

const executable: AvailableInstallation = { kind: "available", via: "executable", command: "/bin/fake", version: "1.0.0" };

const neverSession: Runtime["session"] = async () => {
  await Promise.resolve();
  throw new Error("not exercised");
};

const noInventory = async () => ({
  kind: "unsupported" as const,
  code: "native_query_unavailable" as const,
  reason: "not exercised",
});

function runtime(id: string, extra: Partial<Runtime>): Runtime {
  return {
    skills: noInventory,
    mcpServers: noInventory,
    tools: noInventory,
    id,
    brand: { name: id, icon: null },
    session: neverSession,
    installation: async () => {
      await Promise.resolve();
      return executable;
    },
    ...extra,
  };
}

const silent: Interaction = {
  onEvent: () => {},
  prompt: async () => {
    await Promise.resolve();
    return "";
  },
};

test("events print what a person opens and types", () => {
  expect([
    renderLoginEvent({ kind: "auth_url", url: "https://example.com/authorize", instructions: "Open this URL and sign in; if the page then shows a code, paste it back." }),
    renderLoginEvent({ kind: "auth_url", url: "https://example.com/authorize" }),
    renderLoginEvent({ kind: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://example.com/device", expiresInSeconds: 900 }),
    renderLoginEvent({ kind: "info", message: "Device code sign-in must be allowed first." }),
  ]).toMatchInlineSnapshot(`
    [
      [
        "Open this URL and sign in; if the page then shows a code, paste it back.",
        "  https://example.com/authorize",
      ],
      [
        "Open this URL to sign in:",
        "  https://example.com/authorize",
      ],
      [
        "Open https://example.com/device and enter this code (expires in 900 s):",
        "  ABCD-EFGH",
      ],
      [
        "Device code sign-in must be allowed first.",
      ],
    ]
  `);
});

test("a login reports the runtime's result and maps it to the exit code", async () => {
  const results = [
    { kind: "logged_in", account: { email: "user@example.com", plan: "pro", method: "claude.ai" } },
    { kind: "cancelled" },
    { kind: "failed", reason: "rejected", detail: "invalid_grant" },
    { kind: "unsupported", reason: "terms_of_service" },
  ] as const;
  const reports = await Promise.all(results.map(async (result) => runLogin(runtime("fake", {
    login: async () => {
      await Promise.resolve();
      return result;
    },
  }), silent)));
  expect(reports.map((report) => [renderLoginReport(report), loginExitCode(report)])).toMatchInlineSnapshot(`
    [
      [
        "fake	logged in as user@example.com (claude.ai, pro)",
        0,
      ],
      [
        "fake	login cancelled",
        130,
      ],
      [
        "fake	login failed: rejected (invalid_grant)",
        1,
      ],
      [
        "fake	login unsupported: terms_of_service",
        1,
      ],
    ]
  `);
});

test("a runtime without a login, or whose login throws, fails the command", async () => {
  const none = await runLogin(runtime("pi", {}), silent);
  assert.equal(renderLoginReport(none), "pi\tpi has no login oar can drive");
  const broken = await runLogin(runtime("broken", {
    login: async () => {
      await Promise.resolve();
      throw new Error("spawn EACCES");
    },
  }), silent);
  assert.equal(renderLoginReport(broken), "broken\terror: spawn EACCES");
  assert.equal(loginExitCode(none), 1);
  assert.equal(loginExitCode(broken), 1);
});

test("--status reports each runtime's own status query", async () => {
  const statuses = [
    { kind: "logged_in", account: { email: "user@example.com" }, source: "fake status" },
    { kind: "logged_out", source: "fake status" },
    { kind: "unknown", detail: "Error loading configuration", source: "fake status" },
  ] as const;
  const reports = await Promise.all(statuses.map(async (status) => readAuthStatus(runtime("fake", {
    authStatus: async () => {
      await Promise.resolve();
      return status;
    },
  }))));
  const none = await readAuthStatus(runtime("agy", {}));
  expect([...reports, none].map((report) => renderAuthStatus(report))).toMatchInlineSnapshot(`
    [
      "fake	logged in as user@example.com",
      "fake	logged out",
      "fake	status unknown (Error loading configuration)",
      "agy	agy exposes no sign-in status query",
    ]
  `);
});

test("a pasted code or a secret is typed blind, any other answer is echoed", () => {
  assert.equal(hidesInput({ kind: "manual_code", message: "Paste" }), true);
  assert.equal(hidesInput({ kind: "secret", message: "API key" }), true);
  assert.equal(hidesInput({ kind: "text", message: "Email" }), false);
});

/** What reaches the screen through an echo gate after `steps`. */
async function throughGate(steps: (gate: EchoGate) => void): Promise<string> {
  const screen = new PassThrough();
  const written: string[] = [];
  screen.on("data", (chunk: Buffer) => {
    written.push(chunk.toString());
  });
  const gate = new EchoGate(screen);
  steps(gate);
  const ended = Promise.withResolvers<void>();
  gate.end(ended.resolve);
  await ended.promise;
  return written.join("");
}

test("the echo gate drops what the terminal echoes while muted", async () => {
  const screen = await throughGate((gate) => {
    gate.write("Paste the code: ");
    gate.muted = true;
    gate.write("pasted-authorization-code#state");
    gate.muted = false;
    gate.write("\n");
  });
  assert.equal(screen, "Paste the code: \n");
});

test("a select prompt takes an option's number or its id", () => {
  const prompt = { kind: "select", message: "Provider", options: [{ id: "anthropic", label: "Anthropic" }, { id: "openai", label: "OpenAI" }] } as const;
  assert.equal(selectAnswer(prompt, "2"), "openai");
  assert.equal(selectAnswer(prompt, " anthropic "), "anthropic");
  assert.equal(selectAnswer({ kind: "manual_code", message: "Paste" }, " code#state "), " code#state ");
});
