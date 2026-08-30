import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  ExecutableRunner,
  ExecutableRunOptions,
} from "../packages/oar/src/shared/executable/index.js";
import { kimiAccountUsage } from "../packages/oar/src/runtimes/kimi/account-usage.js";
import { resolveKimiAuth } from "../packages/oar/src/runtimes/kimi/auth-config.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ runExecutable }));

const temporaryDirectories: string[] = [];
const defaultProviderList = {
  providers: {
    "managed:kimi-code": {
      type: "kimi",
      baseUrl: "https://api.kimi.com/coding/v1",
      oauth: { storage: "file", key: "oauth/kimi-code" },
    },
  },
};

async function temporaryKimiHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "oar-kimi-usage-"));
  temporaryDirectories.push(home);
  return home;
}

async function writeToken(home: string, expiresAt: number): Promise<string> {
  const path = join(home, "credentials", "kimi-code.json");
  await mkdir(join(home, "credentials"), { recursive: true });
  await writeFile(path, JSON.stringify({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: expiresAt,
    expires_in: 3600,
    scope: "openid",
    token_type: "Bearer",
  }));
  return path;
}

function mockDefaultProviderList(): void {
  runExecutable.mockImplementation(async (
    command: string,
    arguments_: readonly string[],
    options?: ExecutableRunOptions,
  ) => {
    expect([command, arguments_, typeof options?.timeoutMs])
      .toEqual(["kimi", ["provider", "list", "--json"], "number"]);
    return {
      ok: true,
      stdout: JSON.stringify(defaultProviderList),
      stderr: "",
      exitCode: 0,
    };
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  runExecutable.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

test("kimi reader follows the CLI's resolved provider and stored token", async () => {
  const home = await temporaryKimiHome();
  vi.stubEnv("KIMI_CODE_HOME", home);
  await writeToken(home, Math.floor(Date.now() / 1000) + 3600);
  mockDefaultProviderList();
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer old-access");
    return input === "https://api.kimi.com/coding/v1/me"
      ? Response.json({ user_id: "user-1", email: "person@example.com" })
      : Response.json({
          usage: { used: "25", limit: "100", resetTime: "2030-01-01T00:00:00Z" },
        });
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(kimiAccountUsage({
    kind: "available",
    via: "executable",
    command: "kimi",
    version: "0.38.0",
  })).resolves.toMatchObject({
    kind: "available",
    email: "person@example.com",
    rateLimited: false,
    windows: [{ label: "Weekly limit", usedRatio: 0.25 }],
  });
  expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
    "https://api.kimi.com/coding/v1/usages",
    "https://api.kimi.com/coding/v1/me",
  ]);
});

test("kimi reader keeps usage when the optional identity endpoint fails", async () => {
  const home = await temporaryKimiHome();
  vi.stubEnv("KIMI_CODE_HOME", home);
  await writeToken(home, Math.floor(Date.now() / 1000) + 3600);
  mockDefaultProviderList();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => input.toString().endsWith("/me")
    ? new Response("unavailable", { status: 503 })
    : Response.json({ usage: { used: "25", limit: "100" } })));

  await expect(kimiAccountUsage({
    kind: "available",
    via: "executable",
    command: "kimi",
    version: "0.38.0",
  })).resolves.toEqual({
    kind: "available",
    rateLimited: false,
    windows: [{ label: "Weekly limit", usedRatio: 0.25 }],
  });
});

test("kimi auth resolution scopes environment overrides to their own credential", async () => {
  const home = await temporaryKimiHome();
  vi.stubEnv("KIMI_CODE_HOME", home);
  vi.stubEnv("KIMI_CODE_BASE_URL", "https://api.example.test/coding/v1/");
  vi.stubEnv("KIMI_CODE_OAUTH_HOST", "https://auth.example.test/");
  mockDefaultProviderList();

  const auth = await resolveKimiAuth("kimi", Date.now() + 5000);
  expect(auth).toMatchObject({
    baseUrl: "https://api.example.test/coding/v1",
    oauthHost: "https://auth.example.test",
    storage: "file",
    home,
  });
  expect(auth?.storageName).toMatch(/^kimi-code-env-[0-9a-f]{16}$/u);
  expect(auth?.credentialPath).toBe(join(home, "credentials", `${auth?.storageName}.json`));
});

test("kimi reader sends the stored token as-is and maps a stale 401 to reauth", async () => {
  const home = await temporaryKimiHome();
  vi.stubEnv("KIMI_CODE_HOME", home);
  await writeToken(home, Math.floor(Date.now() / 1000) - 60);
  mockDefaultProviderList();
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    expect(new URL(input.toString()).origin).toBe("https://api.kimi.com");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer old-access");
    return new Response("expired", { status: 401 });
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(kimiAccountUsage({
    kind: "available",
    via: "executable",
    command: "kimi",
    version: "0.38.0",
  })).resolves.toEqual({ kind: "reauth_required" });
});

test("kimi reader reports reauth without any request when no token is stored", async () => {
  const home = await temporaryKimiHome();
  vi.stubEnv("KIMI_CODE_HOME", home);
  mockDefaultProviderList();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expect(kimiAccountUsage({
    kind: "available",
    via: "executable",
    command: "kimi",
    version: "0.38.0",
  })).resolves.toEqual({ kind: "reauth_required" });
  expect(fetchMock).not.toHaveBeenCalled();
});
