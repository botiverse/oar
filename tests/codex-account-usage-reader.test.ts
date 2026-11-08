import { setImmediate as tick } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { isNonSubscriptionAccount } from "../packages/oar/src/runtimes/codex/account-request.js";
import { readFromAppServer } from "../packages/oar/src/runtimes/codex/account-usage.js";
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
      rootPid: () => undefined,
      async observeCancellation() { return { commit() {}, complete() {} }; },
      async request(method) {
        calls.push(method);
        return request(method);
      },
      notify(method) {
        calls.push(method);
      },
      respond() {},
      handle() {},
      mark(placed) {
        placed();
      },
      onExit() {},
      kill() {},
      resources: async () => null,
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
        "reason": "unsupported_auth_mode",
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
        "reason": "unsupported_auth_mode",
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
        "reason": "not_authenticated",
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


test("codex distinguishes missing usage endpoint from unsupported auth mode", async () => {
  const server = fakeAppServer(async (method) => {
    if (method === "initialize") {
      return {};
    }
    if (method === "account/read") {
      return { account: { type: "chatgpt" } };
    }
    throw new Error("method not found");
  });
  await expect(readFromAppServer("codex", 1000, () => server.client)).resolves.toEqual({ kind: "unsupported", reason: "endpoint_unavailable" });
});

test("usage forwards the environment to its app-server", async () => {
  const { client } = fakeAppServer(async () => ({ account: { type: "apiKey" } }));
  const start = vi.fn(() => client);
  const env = { CODEX_HOME: "private-home", HTTP_PROXY: null };
  await readFromAppServer("codex", 1000, start, env);
  expect(start).toHaveBeenCalledWith("codex", env);
});

// An answer arriving after the deadline must not start the next account
// request, especially a redemption or the legacy-params fallback.
// oxlint-disable-next-line max-statements -- Observe timeout, then release the held native answer and verify no next request.
test.each(["initialize", "account/read", "account/rateLimits/read"])("a late %s answer cannot continue a timed-out read", async (stage) => {
  const late = Promise.withResolvers<Record<string, unknown>>();
  const server = fakeAppServer(async (method) => method === stage ? late.promise : {});
  const kill = vi.spyOn(server.client, "kill");
  await expect(readFromAppServer("codex", 20, () => server.client)).resolves.toEqual({ kind: "error" });
  expect(kill).toHaveBeenCalled();
  const sent = [...server.calls];
  if (stage === "account/rateLimits/read") { late.reject(new Error("invalid type: map, expected unit")); }
  else { late.resolve({}); }
  await tick();
  expect(server.calls).toEqual(sent);
});
