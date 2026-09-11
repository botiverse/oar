import type { Dispatcher, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

/*
 * The proxy plane for an embedded pi: undici's global dispatcher set to an
 * `EnvHttpProxyAgent`, nothing else.
 *
 * Why it exists: every pi entry point (SDK 0.84.2 cli.js, rpc-entry.js,
 * main.js) installs such a dispatcher before its first provider request; the
 * public SDK entry does not, so an embedded pi ran on Node's default
 * dispatcher, which ignores HTTP_PROXY / HTTPS_PROXY / NO_PROXY. Behind a
 * proxy every provider call died with pi's auto-retry "fetch failed" while
 * `pi` itself worked (live battery, 2026-09-11, Node 26.7).
 *
 * Why not pi's own `configureHttpDispatcher()`: it also replaces
 * globalThis.fetch / Headers / Request / Response / WebSocket / FormData …
 * (`undici.install()`) for the whole host process, a footprint no embedding
 * library should have. The module is not exported by the SDK either. So the
 * plane is built here with undici directly, a direct dependency pinned to
 * the version pi itself uses (8.9.0, one instance in the tree), and limited
 * to what the fix needs: the proxy agent, pi's `httpProxy` setting as the
 * fallback when the env names no proxy (pi's own precedence), and pi's
 * `httpIdleTimeoutMs` setting as the dispatcher's headers/body timeout (pi's
 * defaults equal undici's when there is none). Node's fetch reads the global
 * dispatcher through `Symbol.for("undici.globalDispatcher.1")`, so its own
 * classes stay in place; compressed bodies decode as before (probed on Node
 * 26.7, whose bundled undici is the same 8.9.0).
 *
 * The global dispatcher is process-global by nature, with the same caveat
 * as pi's lazy env reads: one embedded pi per process.
 */

/** The slice of pi's SettingsManager the plane reads; structural for tests. */
export interface PiHttpSettings {
  getGlobalSettings(): { readonly httpProxy?: string };
  getHttpIdleTimeoutMs(): number;
}

/** The proxy variables undici reads, in its own precedence (lowercase first). */
export type PiProxyEnv = Readonly<Partial<Record<"http_proxy" | "HTTP_PROXY" | "https_proxy" | "HTTPS_PROXY", string>>>;

/** What the dispatcher is built from; `undefined` leaves undici's own reading/default in place. */
export interface PiHttpPlan {
  readonly httpProxy: string | undefined;
  readonly httpsProxy: string | undefined;
  readonly idleTimeoutMs: number | undefined;
}

function settingProxy(settings: PiHttpSettings | undefined): string | undefined {
  const proxy = settings?.getGlobalSettings().httpProxy?.trim();
  return proxy === undefined || proxy.length === 0 ? undefined : proxy;
}

/**
 * pi's precedence (main.js `applyHttpProxySettings`: `process.env.HTTP_PROXY
 * ??= setting`): an env proxy wins, the settings' `httpProxy` fills BOTH
 * http and https when the env names none. Pure, and the env is not written.
 */
export function planPiHttp(settings?: PiHttpSettings, env: PiProxyEnv = process.env): PiHttpPlan {
  const fallback = settingProxy(settings);
  return {
    httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? fallback,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? fallback,
    idleTimeoutMs: settings?.getHttpIdleTimeoutMs(),
  };
}

/** The undici exports the plane uses. */
interface UndiciPlane {
  readonly EnvHttpProxyAgent: typeof EnvHttpProxyAgent;
  readonly getGlobalDispatcher: typeof getGlobalDispatcher;
  readonly setGlobalDispatcher: typeof setGlobalDispatcher;
}

/** undici's own default when nothing is configured; pi's getHttpIdleTimeoutMs() default is the same. */
const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;

let loading: Promise<UndiciPlane> | null = null;
let warned = false;
/** What this module installed, so repeated calls with the same plan are no-ops and another owner's dispatcher is never replaced. */
let installed: { readonly plan: string; readonly dispatcher: Dispatcher } | null = null;

/** Whether the plan changes anything over Node's default dispatcher. */
export function planNeedsDispatcher(plan: PiHttpPlan): boolean {
  return plan.httpProxy !== undefined || plan.httpsProxy !== undefined
    || (plan.idleTimeoutMs !== undefined && plan.idleTimeoutMs !== UNDICI_DEFAULT_TIMEOUT_MS);
}

/** Warn once per process; the session then runs on Node's default dispatcher, as before the plane existed. */
function warnOnce(error: unknown): void {
  if (warned) {
    return;
  }
  warned = true;
  const detail = error instanceof Error ? error.message : String(error);
  process.emitWarning(
    `pi proxy plane not installed (${detail}): provider requests use Node's default dispatcher, which ignores HTTP_PROXY/HTTPS_PROXY`,
    { code: "OAR_PI_PROXY_PLANE" },
  );
}

/** undici, loaded lazily; a failed load is not cached, so a transient failure is retried on the next call. */
async function loadUndici(): Promise<UndiciPlane> {
  const attempt = loading ?? import("undici");
  loading = attempt;
  try {
    return await attempt;
  } catch (error: unknown) {
    if (loading === attempt) {
      loading = null;
    }
    throw error;
  }
}

/**
 * Install the proxy plane before the first provider request: undici's
 * global dispatcher becomes an `EnvHttpProxyAgent` built from the plan.
 * Nothing is installed when the plan changes nothing over Node's default
 * (no proxy, default timeout): the host keeps its stock dispatcher. Repeated
 * calls with the same plan are no-ops; a dispatcher this module did not
 * install (the host's own) is never replaced; a one-time warning says so.
 * True when the plane is in place, false otherwise.
 */
export async function configurePiHttp(settings?: PiHttpSettings): Promise<boolean> {
  try {
    const plan = planPiHttp(settings);
    if (!planNeedsDispatcher(plan)) {
      return false;
    }
    const undici = await loadUndici();
    const key = JSON.stringify(plan);
    const current = undici.getGlobalDispatcher();
    if (installed !== null && installed.plan === key && current === installed.dispatcher) {
      return true;
    }
    // Node's default dispatcher is its BUNDLED undici's Agent, a different
    // class object from the npm undici this module loads, so "stock" is
    // judged by name; anything else that is not ours belongs to the host.
    const foreign = current.constructor.name !== "Agent" && current !== installed?.dispatcher;
    if (foreign) {
      warnOnce(new Error("the host already set a global dispatcher"));
      return false;
    }
    const dispatcher = new undici.EnvHttpProxyAgent({
      ...(plan.httpProxy === undefined ? {} : { httpProxy: plan.httpProxy }),
      ...(plan.httpsProxy === undefined ? {} : { httpsProxy: plan.httpsProxy }),
      ...(plan.idleTimeoutMs === undefined ? {} : { headersTimeout: plan.idleTimeoutMs, bodyTimeout: plan.idleTimeoutMs }),
    });
    undici.setGlobalDispatcher(dispatcher);
    installed = { plan: key, dispatcher };
    return true;
  } catch (error: unknown) {
    warnOnce(error);
    return false;
  }
}
