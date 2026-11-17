import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { kimiAccountUsage } from "../../packages/oar/src/runtimes/kimi/account-usage.js";

const runExecutable = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ runExecutable }));
const homes: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(async p => { await rm(p, { recursive: true, force: true }); })); });
const installation = { kind: "available", via: "executable", command: "kimi", version: "2.6.2" } as const;

async function setup(refresh = "synthetic-refresh", expired = true): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kimi-expired-unit-")); homes.push(home);
  const file = join(home, "credentials", "kimi-code.json"); await mkdir(join(home, "credentials"));
  await writeFile(file, JSON.stringify({ access_token: "synthetic-expired", refresh_token: refresh, expires_at: Date.now() / 1000 + (expired ? -60 : 900) }));
  vi.stubEnv("KIMI_CODE_HOME", home); vi.stubEnv("KIMI_DISABLE_OAUTH_LOCK", "1");
  runExecutable.mockResolvedValue({ ok: true, stdout: JSON.stringify({ providers: { "managed:kimi-code": { type: "kimi", oauth: { storage: "file", key: "oauth/kimi-code" } } } }), stderr: "", exitCode: 0 });
  return file;
}

test.each(["disabled lock", "Windows"])("expired refreshable credentials do not send requests with %s", async mode => {
  const file = await setup(); const before = await readFile(file, "utf8");
  if (mode === "Windows") { vi.stubEnv("KIMI_DISABLE_OAUTH_LOCK", undefined); vi.spyOn(process, "platform", "get").mockReturnValue("win32"); }
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(kimiAccountUsage(installation)).resolves.toEqual({ kind: "unavailable", reason: "access_token_expired" });
  expect(fetchMock).not.toHaveBeenCalled(); expect(await readFile(file, "utf8")).toBe(before);
});

test("expired credentials without a refresh token require login without HTTP", async () => {
  await setup(""); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(kimiAccountUsage(installation)).resolves.toEqual({ kind: "reauth_required", reason: "credentials_missing" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a fresh token still reads usage on a platform without locking", async () => {
  await setup("synthetic-refresh", false);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ usage: { used: 1, limit: 10 } })));
  await expect(kimiAccountUsage(installation)).resolves.toMatchObject({ kind: "available", windows: [{ usedRatio: 0.1 }] });
});
