import { once } from "node:events";
import { createServer } from "node:http";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, test } from "vitest";
import { configurePiHttp, planPiHttp, type PiHttpSettings } from "../../packages/oar/src/runtimes/pi/http.js";

function settingsOf(httpProxy: string | undefined, idleTimeoutMs = 300_000): PiHttpSettings {
  return {
    getGlobalSettings: () => (httpProxy === undefined ? {} : { httpProxy }),
    getHttpIdleTimeoutMs: () => idleTimeoutMs,
  };
}

// pi's own precedence (main.js: the setting is copied into the env with ??=,
// so an env proxy wins and the setting fills both http and https), computed
// without writing the env; the idle timeout is pi's setting verbatim (0 =
// disabled, as in undici).
test("planPiHttp: env proxy wins, the httpProxy setting fills both when the env names none", () => {
  expect(planPiHttp(settingsOf("http://setting.example:3128", 60_000), {})).toEqual({
    httpProxy: "http://setting.example:3128",
    httpsProxy: "http://setting.example:3128",
    idleTimeoutMs: 60_000,
  });
  expect(planPiHttp(settingsOf("http://setting.example:3128"), { HTTP_PROXY: "http://env.example:8080" })).toEqual({
    httpProxy: "http://env.example:8080",
    httpsProxy: "http://setting.example:3128",
    idleTimeoutMs: 300_000,
  });
  // undici reads the lowercase spelling first; the plan follows it.
  expect(planPiHttp(undefined, { http_proxy: "http://lower.example", HTTP_PROXY: "http://upper.example" }).httpProxy)
    .toBe("http://lower.example");
  // A blank setting is no setting; no settings at all leaves undici's defaults.
  expect(planPiHttp(settingsOf("  ", 0), {})).toEqual({ httpProxy: undefined, httpsProxy: undefined, idleTimeoutMs: 0 });
  expect(planPiHttp(undefined, {})).toEqual({ httpProxy: undefined, httpsProxy: undefined, idleTimeoutMs: undefined });
});

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const PROXY_ENV = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];

/** Leave exactly the given proxy variables set; returns the restore step. */
function applyProxyEnv(env: Readonly<Record<string, string>>): () => void {
  const saved = PROXY_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of PROXY_ENV) {
    setEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(env)) {
    setEnv(name, value);
  }
  return (): void => {
    for (const [name, value] of saved) {
      setEnv(name, value);
    }
  };
}

/** Run `work` with exactly the given proxy variables set, restoring the process env and the global dispatcher afterwards. */
async function withProxyEnv<T>(env: Readonly<Record<string, string>>, work: () => Promise<T>): Promise<T> {
  const restoreEnv = applyProxyEnv(env);
  const dispatcher = getGlobalDispatcher();
  try {
    return await work();
  } finally {
    restoreEnv();
    setGlobalDispatcher(dispatcher);
  }
}

/** A local HTTP server standing in as the proxy; records the request lines it receives. */
async function listenProxy(hits: string[]): Promise<{ url: string; close: () => void }> {
  const proxy = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end("via-proxy");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, close: (): void => { proxy.close(); } };
}

// The observable effect, no external network: a local server stands in as
// HTTP_PROXY, and after configuration a fetch to a host that does not exist
// arrives there in proxy form (absolute-URL request line). Node's default
// dispatcher ignores HTTP_PROXY / HTTPS_PROXY — the "fetch failed" the live
// battery hit behind a proxy on 2026-09-11.
test("after configurePiHttp, fetch goes through HTTP_PROXY like pi itself", async () => {
  const hits: string[] = [];
  const proxy = await listenProxy(hits);
  try {
    await withProxyEnv({ HTTP_PROXY: proxy.url }, async () => {
      await expect(configurePiHttp()).resolves.toBe(true);
      const response = await fetch("http://oar-proxy-probe.invalid/ping");
      await expect(response.text()).resolves.toBe("via-proxy");
    });
    expect(hits).toEqual(["http://oar-proxy-probe.invalid/ping"]);
  } finally {
    proxy.close();
  }
});

// pi's global `httpProxy` setting reaches the dispatcher without being
// written into the process env (pi's main.js writes it; the adapter does not).
test("the settings' httpProxy is honored when the env names no proxy, and the env is left alone", async () => {
  const hits: string[] = [];
  const proxy = await listenProxy(hits);
  try {
    await withProxyEnv({}, async () => {
      await expect(configurePiHttp(settingsOf(proxy.url))).resolves.toBe(true);
      const response = await fetch("http://oar-proxy-probe.invalid/settings");
      await expect(response.text()).resolves.toBe("via-proxy");
      expect(process.env.HTTP_PROXY).toBeUndefined();
      expect(process.env.HTTPS_PROXY).toBeUndefined();
    });
    expect(hits).toEqual(["http://oar-proxy-probe.invalid/settings"]);
  } finally {
    proxy.close();
  }
});

// The plane is the global dispatcher and nothing more: pi's own
// configureHttpDispatcher() also swaps in undici's fetch/Headers/Request/
// Response/WebSocket/FormData for the whole host process; the adapter must not.
test("configurePiHttp sets only the global dispatcher; the global fetch classes are untouched", async () => {
  const before = {
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    FormData: globalThis.FormData,
    WebSocket: globalThis.WebSocket,
  };
  await withProxyEnv({}, async () => {
    await expect(configurePiHttp(settingsOf(undefined, 45_000))).resolves.toBe(true);
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    expect(globalThis.fetch).toBe(before.fetch);
    expect(globalThis.Headers).toBe(before.Headers);
    expect(globalThis.Request).toBe(before.Request);
    expect(globalThis.Response).toBe(before.Response);
    expect(globalThis.FormData).toBe(before.FormData);
    expect(globalThis.WebSocket).toBe(before.WebSocket);
  });
});
