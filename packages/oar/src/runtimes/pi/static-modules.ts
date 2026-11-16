import { configurePiHttp, type PiHttpSettings } from "./http.js";
import { preparePiTheme, type PiThemeSettings } from "./theme.js";

/*
 * Pi's computed imports cannot find provider files beside a single-file
 * Node host (#328). Register the OAuth table and the native lazy Bedrock
 * loader through literal imports so bundlers retain both implementations.
 * Pi 1.5.2's loader waits for the first Bedrock request before importing the
 * AWS SDK, including when a host opens Pi or queries provider auth first.
 *
 * Registration is best effort: a host may omit a module from its bundle.
 * A failed registration warns once and retries on the next call; Pi retains
 * its own fallback loader. A later Bedrock import failure is its native
 * request error, not an OAR startup failure.
 */
let provided: Promise<void> | null = null;
let warned = false;

async function registerSignInFlows(): Promise<void> {
  const { registerBunOAuthFlows } = await import("@earendil-works/pi-ai/bun-oauth");
  registerBunOAuthFlows();
}

async function registerBedrock(): Promise<void> {
  const { registerLazyBedrockProvider } = await import("@earendil-works/pi-ai/lazy-bedrock-provider");
  registerLazyBedrockProvider();
}

function warnOnce(reason: unknown): void {
  if (warned) {
    return;
  }
  warned = true;
  const detail = reason instanceof Error ? reason.message : String(reason);
  process.emitWarning(`pi provider modules not all handed to pi-ai (${detail}): pi loads those itself, which a single-file host cannot`, { code: "OAR_PI_MODULES" });
}

async function provide(): Promise<void> {
  const results = await Promise.allSettled([registerSignInFlows(), registerBedrock()]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) {
    warnOnce(failure.reason);
    provided = null;
  }
}

/** Register Pi's sign-in flows and lazy Bedrock loader once per process; never throws. */
export async function providePiModules(): Promise<void> {
  provided ??= provide();
  await provided;
}

/**
 * pi's process-wide setup before it first reaches a provider or runs an
 * extension: the proxy plane (http.ts), pi-ai's provider modules and the
 * theme (theme.ts).
 */
export async function preparePi(settings: PiHttpSettings & PiThemeSettings): Promise<void> {
  await Promise.all([configurePiHttp(settings), providePiModules(), preparePiTheme(settings)]);
}
