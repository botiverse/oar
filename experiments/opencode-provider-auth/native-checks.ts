/* oxlint-disable no-console, no-await-in-loop, promise/avoid-new -- An experiment reports on stdout, runs its steps one at a time and waits for a line. */
// Native checks on a real OpenCode 2 in an isolated HOME, with no account and
// no key: (1) a raw `opencode serve` with BROWSER pointing at a recording
// script and the update and catalog flags set: readiness, the registry size,
// a wrong password's answer, and whether connecting the browser methods runs
// BROWSER; (2) a host that creates the facade and SIGKILLs itself: whether
// its `opencode serve` survives. Every process started here is stopped.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [commandArgument, outputArgument] = process.argv.slice(2);
if (commandArgument === undefined || outputArgument === undefined) {
  throw new Error("usage: pnpm tsx experiments/opencode-provider-auth/native-checks.ts /path/to/opencode <new-output-directory>");
}
const command: string = commandArgument;
const output: string = outputArgument;
mkdirSync(output, { recursive: true });
if (readdirSync(output).length > 0) {
  throw new Error(`${output} is not empty`);
}
const observations: Record<string, unknown> = {};

async function rawServe(): Promise<void> {
  const home = path.resolve(output, "raw-home");
  mkdirSync(home);
  const marker = path.resolve(output, "browser-calls.txt");
  const browser = path.resolve(output, "record-browser.sh");
  writeFileSync(browser, `#!/bin/sh\necho "$1" >> "${marker}"\n`, { mode: 0o755 });
  const password = "native-check-password";
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_PASSWORD: password, BROWSER: browser, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" };
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) { delete env[name]; }
  const started = Date.now();
  const child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { env, cwd: home, stdio: ["ignore", "pipe", "ignore"], detached: true });
  try {
    const url = await new Promise<string>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        const found = /server listening on (?<url>\S+)/u.exec(chunk.toString())?.groups?.url;
        if (found !== undefined) { resolve(found); }
      });
    });
    const get = async (route: string, secret = password): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${url}${route}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}` } });
      const body: unknown = JSON.parse(await response.text());
      return { status: response.status, body };
    };
    const count = async (route: string): Promise<number> => {
      const { body } = await get(route);
      const data = typeof body === "object" && body !== null && "data" in body ? body.data : undefined;
      return Array.isArray(data) ? data.length : 0;
    };
    while (await count("/api/plugin") === 0 || await count("/api/integration") === 0) {
      if (Date.now() - started > 30_000) { throw new Error("never ready"); }
      await delay(100);
    }
    observations.readyMs = Date.now() - started;
    observations.integrationsWithFlags = await count("/api/integration");
    observations.wrongPassword = await get("/api/integration", "wrong-password");
    const connects: Record<string, string> = {};
    for (const [id, methodID, answer] of [["openai", "chatgpt-token-sharing"], ["openai", "chatgpt-browser"], ["gitlab", "pkce"], ["poe", "browser"], ["digitalocean", "browser"], ["snowflake-cortex", "browser", { account: "exampleorg-example" }]] as const) {
      const response = await fetch(`${url}/api/integration/${id}/connect/oauth`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
        body: JSON.stringify({ methodID, ...(answer === undefined ? {} : { answer }) }),
      });
      const parsed: unknown = JSON.parse(await response.text());
      const data = typeof parsed === "object" && parsed !== null && "data" in parsed && typeof parsed.data === "object" && parsed.data !== null ? parsed.data : {};
      const attemptID = "attemptID" in data && typeof data.attemptID === "string" ? data.attemptID : "none";
      const authorize = "url" in data && typeof data.url === "string" ? data.url : undefined;
      const redirect = authorize === undefined ? null : new URL(authorize).searchParams.get("redirect_uri");
      connects[`${id} ${methodID}`] = `${String(response.status)} redirect_uri=${redirect ?? "none"}`;
      await fetch(`${url}/api/integration/${id}/connect/oauth/${attemptID}`, {
        method: "DELETE",
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      });
    }
    observations.connects = connects;
    await delay(1500);
    observations.browserCalls = existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((line) => line !== "").length : 0;
  } finally {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
}

async function killedHost(): Promise<void> {
  const home = path.resolve(output, "host-home");
  mkdirSync(home);
  const entry = pathToFileURL(path.resolve(import.meta.dirname, "../../packages/oar/src/runtimes/opencode/provider-auth.ts")).href;
  const script = `import { createOpencodeProviderAuth } from ${JSON.stringify(entry)};
const auth = await createOpencodeProviderAuth({ kind: "available", via: "executable", command: ${JSON.stringify(command)} }, { env: { HOME: ${JSON.stringify(home)}, USERPROFILE: ${JSON.stringify(home)} }, idleMs: 600000 });
console.log(auth.loginProviders().length);
process.kill(process.pid, "SIGKILL");`;
  const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
  const survivors = (): number => {
    try { return execFileSync("pgrep", ["-f", `${command} serve`], { encoding: "utf8" }).trim().split("\n").length; } catch { return 0; }
  };
  observations.host = { signal: host.signal, loginProviders: Number(host.stdout.trim()) };
  observations.serveRightAfterHostKill = survivors();
  await delay(3000);
  observations.serveThreeSecondsLater = survivors();
}

await rawServe();
await killedHost();
writeFileSync(path.join(output, "native-checks.json"), `${JSON.stringify(observations, null, 2)}\n`);
console.log(JSON.stringify(observations, null, 2));
