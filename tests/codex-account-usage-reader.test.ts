import { expect, test } from "vitest";
import {
  isNonSubscriptionAccount,
  readFromAppServer,
} from "../packages/oar/src/runtimes/codex/account-usage.js";
import type { AppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";

function fakeAppServer(
  request: (method: string) => Promise<Record<string, unknown>>,
): { readonly client: AppServerClient; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      spawned: Promise.resolve(),
      exited: Promise.resolve(0),
      async request(method) {
        calls.push(method);
        return request(method);
      },
      notify(method) {
        calls.push(method);
      },
      onNotification() {},
      onExit() {},
      kill() {},
    },
  };
}

test("codex detects valid non-subscription account modes", () => {
  expect(isNonSubscriptionAccount({
    account: { type: "apiKey" },
    requiresOpenaiAuth: true,
  })).toBe(true);
  expect(isNonSubscriptionAccount({
    account: null,
    requiresOpenaiAuth: false,
  })).toBe(true);
  expect(isNonSubscriptionAccount({
    account: { type: "chatgpt", email: "person@example.com" },
    requiresOpenaiAuth: true,
  })).toBe(false);
  expect(isNonSubscriptionAccount({
    account: { type: "future-mode" },
    requiresOpenaiAuth: true,
  })).toBe(false);
});

test("codex API-key mode is unsupported usage rather than expired auth", async () => {
  const server = fakeAppServer(async (method) => {
    if (method === "initialize") {
      return {};
    }
    if (method === "account/read") {
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    }
    throw new Error(`unexpected request: ${method}`);
  });

  await expect(readFromAppServer("codex", 1000, () => server.client)).resolves
    .toMatchInlineSnapshot(`
      {
        "kind": "unsupported",
      }
    `);
  expect(server.calls).toEqual(["initialize", "initialized", "account/read"]);
});

test("codex provider-managed API mode has no subscription usage", async () => {
  const server = fakeAppServer(async (method) => {
    if (method === "initialize") {
      return {};
    }
    if (method === "account/read") {
      return { account: null, requiresOpenaiAuth: false };
    }
    throw new Error(`unexpected request: ${method}`);
  });

  await expect(readFromAppServer("codex", 1000, () => server.client)).resolves
    .toMatchInlineSnapshot(`
      {
        "kind": "unsupported",
      }
    `);
  expect(server.calls).toEqual(["initialize", "initialized", "account/read"]);
});

test("codex missing ChatGPT auth remains reauth required", async () => {
  const server = fakeAppServer(async (method) => {
    if (method === "initialize") {
      return {};
    }
    if (method === "account/read") {
      return { account: null, requiresOpenaiAuth: true };
    }
    throw new Error("codex account authentication required to read rate limits");
  });

  await expect(readFromAppServer("codex", 1000, () => server.client)).resolves
    .toMatchInlineSnapshot(`
      {
        "kind": "reauth_required",
      }
    `);
  expect(server.calls).toEqual([
    "initialize",
    "initialized",
    "account/read",
    "account/rateLimits/read",
  ]);
});

test("codex ChatGPT mode keeps subscription windows and account email", async () => {
  const rateLimits = {
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300 },
    },
  };
  const server = fakeAppServer(async (method) => {
    if (method === "initialize") {
      return {};
    }
    if (method === "account/read") {
      return {
        account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      };
    }
    if (method === "account/rateLimits/read") {
      return rateLimits;
    }
    throw new Error(`unexpected request: ${method}`);
  });

  await expect(readFromAppServer("codex", 1000, () => server.client)).resolves
    .toEqual({ kind: "ok", result: rateLimits, email: "person@example.com" });
  expect(server.calls).toEqual([
    "initialize",
    "initialized",
    "account/read",
    "account/rateLimits/read",
  ]);
});

test("codex older app-server can still return subscription windows", async () => {
  const rateLimits = {
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300 },
    },
  };
  const server = fakeAppServer(async (method) => {
    if (method === "initialize") {
      return {};
    }
    if (method === "account/read") {
      throw new Error("method not found");
    }
    if (method === "account/rateLimits/read") {
      return rateLimits;
    }
    throw new Error(`unexpected request: ${method}`);
  });

  await expect(readFromAppServer("codex", 1000, () => server.client)).resolves
    .toEqual({ kind: "ok", result: rateLimits, email: undefined });
  expect(server.calls).toEqual([
    "initialize",
    "initialized",
    "account/read",
    "account/rateLimits/read",
  ]);
});
