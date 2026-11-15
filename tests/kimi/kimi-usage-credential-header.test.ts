import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/index.js";
import { kimiAccountUsage } from "../../packages/oar/src/runtimes/kimi/account-usage.js";
import { errorChain, rejectionOf } from "../fixtures/error-chain.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ runExecutable }));

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); runExecutable.mockReset();
  await Promise.all(homes.splice(0).map(async (home) => { await rm(home, { recursive: true, force: true }); }));
});
const installation = { kind: "available" as const, via: "executable" as const, command: "kimi", version: "0.38.0" };

/** A Kimi home whose managed provider stores this access token in a file. */
async function kimiHome(accessToken: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "oar-kimi-header-"));
  homes.push(home);
  vi.stubEnv("KIMI_CODE_HOME", home);
  await mkdir(join(home, "credentials"), { recursive: true });
  await writeFile(join(home, "credentials", "kimi-code.json"), JSON.stringify({ access_token: accessToken, refresh_token: "r" }));
  const providers = { providers: { "managed:kimi-code": { type: "kimi", baseUrl: "https://api.kimi.com/coding/v1", oauth: { storage: "file", key: "oauth/kimi-code" } } } };
  runExecutable.mockResolvedValue({ ok: true, stdout: JSON.stringify(providers), stderr: "", exitCode: 0 });
}

test("a stored token that cannot be a header value is refused before any request, without it in the error chain", async () => {
  await kimiHome("SECRET-ACCESS\nX");
  const fetchMock = vi.fn(async () => { await Promise.resolve(); return new Response("{}"); });
  vi.stubGlobal("fetch", fetchMock);
  const chain = errorChain(await rejectionOf(kimiAccountUsage(installation)));
  expect(chain).toMatch(/not a valid HTTP header value/u);
  expect(chain).not.toMatch(/SECRET/u);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a failed request keeps no fetch error as its cause", async () => {
  await kimiHome("old-access");
  vi.stubGlobal("fetch", vi.fn(async () => { await Promise.resolve(); throw new TypeError("Headers.append: \"Bearer old-access\" is an invalid header value."); }));
  const chain = errorChain(await rejectionOf(kimiAccountUsage(installation)));
  expect(chain).toMatch(/Failed to reach Kimi usage endpoint/u);
  expect(chain).not.toMatch(/old-access/u);
});
