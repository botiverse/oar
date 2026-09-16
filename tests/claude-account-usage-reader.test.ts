import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../packages/oar/src/shared/executable/index.js";
import { claudeAccountUsage } from "../packages/oar/src/runtimes/claude/account-usage.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ runExecutable }));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  runExecutable.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

test("claude reader merges the explicit auth-status subscription tier", async () => {
  const config = await mkdtemp(join(tmpdir(), "oar-claude-usage-"));
  temporaryDirectories.push(config);
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  await writeFile(join(config, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: "stored-access",
      scopes: ["user:profile"],
    },
  }));
  runExecutable.mockResolvedValue({
    ok: true,
    stdout: JSON.stringify({
      loggedIn: true,
      email: "person@example.com",
      subscriptionType: "max",
    }),
    stderr: "",
    exitCode: 0,
  });
  const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer stored-access");
    return Response.json({
      limits: [{ kind: "session", percent: 25, severity: "normal" }],
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(claudeAccountUsage({
    kind: "available",
    via: "executable",
    command: "claude",
    version: "2.1.237",
  })).resolves.toMatchObject({
    kind: "available",
    email: "person@example.com",
    plan: "max",
    rateLimited: false,
  });
  expect(runExecutable).toHaveBeenCalledWith(
    "claude",
    ["auth", "status", "--json"],
    expect.objectContaining({ timeoutMs: 15_000 }),
  );
  expect(fetchMock).toHaveBeenCalledOnce();
});

test.each([
  {
    label: "API key",
    authStatus: {
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      apiKeySource: "ANTHROPIC_API_KEY",
    },
  },
  {
    label: "custom API auth token",
    authStatus: {
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
    },
  },
])("claude reader treats $label as valid non-subscription mode", async ({ authStatus }) => {
  const config = await mkdtemp(join(tmpdir(), "oar-claude-usage-"));
  temporaryDirectories.push(config);
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  runExecutable.mockResolvedValue({
    ok: true,
    stdout: JSON.stringify(authStatus),
    stderr: "",
    exitCode: 0,
  });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expect(claudeAccountUsage({
    kind: "available",
    via: "executable",
    command: "claude",
    version: "2.1.233",
  })).resolves.toEqual({ kind: "unsupported", reason: "unsupported_auth_mode" });
  expect(fetchMock).not.toHaveBeenCalled();
});


test.each([
  { label: "missing credential", credential: {}, status: 200, reason: "credentials_missing" },
  { label: "missing profile scope", credential: { claudeAiOauth: { accessToken: "test-token", scopes: [] } }, status: 200, reason: "scope_missing" },
  { label: "rejected credential", credential: { claudeAiOauth: { accessToken: "test-token", scopes: ["user:profile"] } }, status: 401, reason: "credentials_rejected" },
])("claude usage distinguishes $label", async ({ credential, status, reason }) => {
  const config = await mkdtemp(join(tmpdir(), "oar-claude-reason-"));
  temporaryDirectories.push(config);
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  await writeFile(join(config, ".credentials.json"), JSON.stringify(credential));
  runExecutable.mockResolvedValue({ ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "", exitCode: 0 });
  const fetchMock = vi.fn(async () => new Response("", { status }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await claudeAccountUsage({ kind: "available", via: "executable", command: "claude" });
  expect(result).toEqual({ kind: "reauth_required", reason });
  expect(fetchMock).toHaveBeenCalledTimes(reason === "credentials_rejected" ? 1 : 0);
});

test("claude unsupported installation is distinct from unsupported auth", async () => {
  await expect(claudeAccountUsage({ kind: "available", via: "bundled" })).resolves.toEqual({ kind: "unsupported", reason: "unsupported_installation" });
  expect(runExecutable).not.toHaveBeenCalled();
});
