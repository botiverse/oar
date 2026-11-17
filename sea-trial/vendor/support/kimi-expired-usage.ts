import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

interface ExpiredUsageFixture {
  readonly dir: string; readonly home: string; readonly file: string; readonly before: string; readonly trace: string;
  readonly calls: readonly { path: string; fresh: boolean }[];
  readonly env: Readonly<Record<string, string | null>>;
  dispose(): Promise<void>;
}

export async function kimiExpiredUsageFixture(mode: "success" | "rejected" | "network" | "hang"): Promise<ExpiredUsageFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "kimi-usage-native-"));
  const home = path.join(dir, "home"); await mkdir(path.join(home, "credentials"), { recursive: true });
  const calls: { path: string; fresh: boolean }[] = [];
  let refreshed = false;
  const server = createServer((request, response) => {
    const route = request.url ?? "/"; request.resume();
    calls.push({ path: route, fresh: request.headers.authorization === "Bearer synthetic-fresh" });
    const reply = (status: number, value: unknown): void => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (route === "/api/oauth/token") {
      if (mode === "rejected" || refreshed) { reply(401, { error: "invalid_grant", error_description: "PRIVATE fixture rejection" }); }
      else if (mode === "network") { request.socket.destroy(); }
      else if (mode !== "hang") {
        refreshed = true;
        setTimeout(() => { reply(200, { access_token: "synthetic-fresh", refresh_token: "synthetic-rotated", expires_in: 900, token_type: "Bearer" }); }, 200);
      }
    } else if (route === "/usages") { reply(200, { usages: { limit_7d: { used_ratio: 0.25, reset_time: "2030-01-01T00:00:00Z" } } }); }
    else if (route === "/me") { reply(200, { user_id: "fixture", nickname: "Fixture", user_level_name: "Fixture plan" }); }
    else if (route === "/models") { reply(200, { data: [] }); }
    else { reply(404, {}); }
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const slot = `kimi-code-env-${createHash("sha256").update(JSON.stringify({ oauthHost: origin, baseUrl: origin })).digest("hex").slice(0, 16)}`;
  const file = path.join(home, "credentials", `${slot}.json`);
  await writeFile(path.join(home, "config.toml"), `[providers."managed:kimi-code"]\ntype = "kimi"\nbaseUrl = "${origin}"\n[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/${slot}"\n`);
  const trace = path.join(dir, "processes.jsonl");
  const preload = path.join(dir, "observe.cjs");
  await writeFile(preload, `require('node:fs').appendFileSync(process.env.OAR_KIMI_USAGE_TRACE, JSON.stringify({pid: process.pid})+'\\n');`);
  await writeFile(file, JSON.stringify({ access_token: "synthetic-expired", refresh_token: "synthetic-refresh", expires_at: Date.now() / 1000 - 60, expires_in: 900, token_type: "Bearer" }));
  const before = await readFile(file, "utf8");
  return { dir, home, calls, file, before, trace,
    env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, OAR_KIMI_USAGE_TRACE: trace, HOME: dir, USERPROFILE: dir, KIMI_CODE_HOME: home, KIMI_CODE_BASE_URL: origin, KIMI_CODE_OAUTH_HOST: origin, KIMI_DISABLE_TELEMETRY: "1", KIMI_DISABLE_OAUTH_LOCK: null, KIMI_CODE_API_KEY: null, KIMI_API_KEY: null, MOONSHOT_API_KEY: null },
    async dispose(): Promise<void> {
      server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
