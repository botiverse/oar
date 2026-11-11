/* oxlint-disable no-console -- An experiment reports on stdout. */
// Drive createOpencodeProviderAuth against a real OpenCode 2 in an isolated
// HOME: registry, synthetic keys, logout and two OAuth starts that are
// cancelled once their device code arrives. No sign-in is completed.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProviderLoginEvent, ProviderLoginInteraction } from "../../packages/oar/src/contracts/provider-auth.js";
import { createOpencodeProviderAuth } from "../../packages/oar/src/runtimes/opencode/provider-auth.js";

const [command, output] = process.argv.slice(2);
if (command === undefined || output === undefined) {
  throw new Error("usage: pnpm tsx experiments/opencode-provider-auth/probe.ts /path/to/opencode <new-output-directory>");
}
mkdirSync(output, { recursive: true });
if (readdirSync(output).length > 0) {
  throw new Error(`${output} is not empty`);
}
const home = path.resolve(output, "home");
mkdirSync(home);
const observations: Record<string, unknown> = {};

/** The device code is the person's to type; the evidence keeps its shape only. */
function redacted(event: ProviderLoginEvent): ProviderLoginEvent {
  if (event.kind !== "device_code") {
    return event;
  }
  return { ...event, userCode: "<code>", verificationUri: event.verificationUri.replace(event.userCode, "<code>") };
}

/** Answer selects with `answer`, cancel as soon as the URL or code arrives. */
function cancelAtFirstEvent(events: ProviderLoginEvent[], answer: string): ProviderLoginInteraction {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    onEvent: (event) => {
      events.push(redacted(event));
      controller.abort(new Error("cancelled by the probe"));
    },
    prompt: async () => {
      await Promise.resolve();
      return answer;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${"kind" in error ? String(error.kind) : ""} ${error.message}` : String(error);
  }
}

const started = Date.now();
const auth = await createOpencodeProviderAuth({ kind: "available", via: "executable", command }, { env: { HOME: home, USERPROFILE: home } });
observations.createMs = Date.now() - started;
try {
  const providers = auth.loginProviders();
  observations.loginProviders = providers.length;
  observations.oauthProviders = providers.filter((provider) => provider.methods.some((method) => method.method === "oauth")).map((provider) => provider.providerId);
  observations.samples = providers.filter((provider) => ["github-copilot", "openai", "xai", "azure"].includes(provider.providerId));
  observations.listBefore = await auth.listProviders();
  await auth.setApiKey("xai", "xai-synthetic-probe-key-1");
  await auth.setApiKey("xai", "xai-synthetic-probe-key-2");
  observations.xaiAfterTwoKeys = await auth.status("xai");
  observations.listAfterKeys = await auth.listProviders();
  observations.azureSetApiKey = await failure(auth.setApiKey("azure", "azure-synthetic-probe-key"));
  await auth.logout("xai");
  observations.xaiAfterLogout = await auth.status("xai");
  const copilot: ProviderLoginEvent[] = [];
  observations.copilotLogin = await failure(auth.login("github-copilot", "oauth", cancelAtFirstEvent(copilot, "github.com")));
  observations.copilotEvents = copilot;
  const xai: ProviderLoginEvent[] = [];
  observations.xaiLogin = await failure(auth.login("xai", "oauth", cancelAtFirstEvent(xai, "")));
  observations.xaiEvents = xai;
} finally {
  await auth.close();
}
writeFileSync(path.join(output, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
console.log(JSON.stringify(observations, null, 2));
