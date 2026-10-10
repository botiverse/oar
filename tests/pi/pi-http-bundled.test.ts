import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configurePiHttp } from "../../packages/oar/src/runtimes/pi/http.js";

const before = process.env.HTTPS_PROXY;
beforeEach(() => { process.env.HTTPS_PROXY = "http://127.0.0.1:9"; });
afterEach(() => {
  if (before === undefined) { delete process.env.HTTPS_PROXY; } else { process.env.HTTPS_PROXY = before; }
  vi.restoreAllMocks();
});

// #328 (Lookout): in a single-file host esbuild renamed npm undici's Agent to
// `Agent4`, so the Agent undici creates itself read as the host's own
// dispatcher and the proxy plane was skipped with a warning.
test("an Agent whose class a bundler renamed is still undici's stock dispatcher", async () => {
  class Agent4 extends Agent {}
  setGlobalDispatcher(new Agent4());
  const warning = vi.spyOn(process, "emitWarning");
  await expect(configurePiHttp()).resolves.toBe(true);
  expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  expect(warning).not.toHaveBeenCalled();
});
