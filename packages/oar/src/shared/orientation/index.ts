import type { InstallationSnapshot, AvailableInstallation } from "../../contracts/installation.js";
import type { AccountUsageSnapshot } from "../../contracts/account-usage.js";
import type { AuthStatus } from "../../contracts/login.js";
import type { ListModelsResult, ModelEntry } from "../../contracts/list-models.js";
import type { OrientOptions, Orientation, Probe, RuntimeOrientation } from "../../contracts/orientation.js";
import type { Runtime } from "../../contracts/runtime.js";
import type { RuntimeRegistry } from "../../registry.js";
import { ProbeBudget, observedNow } from "./budget.js";
import { ProbeSlots } from "./slots.js";
import { readCustomization } from "./customization.js";

/** Missing installation prevents dependent reads; missing capabilities remain unsupported. */
function unavailable<T>(installation: Probe<InstallationSnapshot>, member: unknown): Probe<T> {
  if (member === undefined) { return { kind: "unsupported" }; }
  if (installation.kind !== "ok") { return installation; }
  return installation.value.kind === "not_found" ? { kind: "skipped", because: "not_installed" } : { kind: "unsupported" };
}

function absent(runtime: Runtime, installation: Probe<InstallationSnapshot>, options: OrientOptions): RuntimeOrientation {
  return {
    id: runtime.id, brand: runtime.brand, installation, auth: unavailable(installation, runtime.authStatus),
    ...(runtime.providers === undefined ? {} : { providers: unavailable(installation, runtime.providers) }),
    ...(options.depth === "account" || options.depth === "models" ? { accountUsage: unavailable(installation, runtime.accountUsage) } : {}),
    ...(options.depth === "models" ? { models: unavailable(installation, runtime.listModels) } : {}),
    ...(options.include?.includes("customization") === true ? { customization: unavailable(installation, runtime.skills) } : {}),
  };
}

async function models(runtime: Runtime, installation: AvailableInstallation, budget: ProbeBudget, slots: ProbeSlots, loggedOut: boolean, options: OrientOptions): Promise<Probe<readonly ModelEntry[]>> {
  const reader = runtime.listModels;
  if (reader !== undefined && loggedOut) { return { kind: "skipped", because: "logged_out" }; }
  const result = await budget.run(reader === undefined ? undefined : async (timeoutMs): Promise<ListModelsResult> => { const value = await reader(installation, { timeoutMs, ...(options.env === undefined ? {} : { env: options.env }) }); return value; }, slots);
  if (result.kind !== "ok") { return result; }
  if (result.value.kind === "ok") { return { kind: "ok", value: result.value.models, observedAt: result.observedAt }; }
  return result.value.kind === "unsupported" ? { kind: "unsupported" } : { kind: "skipped", because: "logged_out" };
}

async function usage(runtime: Runtime, installation: AvailableInstallation, budget: ProbeBudget, loggedOut: boolean, options: OrientOptions): Promise<Probe<AccountUsageSnapshot>> {
  const reader = runtime.accountUsage;
  if (reader !== undefined && loggedOut) { return { kind: "skipped", because: "logged_out" }; }
  const result = await budget.run(reader === undefined ? undefined : async (timeoutMs): Promise<AccountUsageSnapshot> => {
    const value = await reader(installation, { timeoutMs, ...(options.env === undefined ? {} : { env: options.env }) });
    return value;
  });
  return result;
}

async function additional(runtime: Runtime, installation: AvailableInstallation, auth: Probe<AuthStatus>, options: OrientOptions, budget: ProbeBudget, slots: ProbeSlots): Promise<Pick<RuntimeOrientation, "accountUsage" | "models" | "customization">> {
  const loggedOut = auth.kind === "ok" && auth.value.kind === "logged_out";
  const [accountUsage, modelList, customization] = await Promise.all([
    options.depth === "account" || options.depth === "models" ? usage(runtime, installation, budget, loggedOut, options) : undefined,
    options.depth === "models" ? models(runtime, installation, budget, slots, loggedOut, options) : undefined,
    options.include?.includes("customization") === true ? readCustomization(runtime, installation, budget, slots, options.env) : undefined,
  ]);
  return { ...(accountUsage === undefined ? {} : { accountUsage }), ...(modelList === undefined ? {} : { models: modelList }), ...(customization === undefined ? {} : { customization }) };
}

async function readRuntime(runtime: Runtime, requested: OrientOptions, until: number, slots: ProbeSlots): Promise<RuntimeOrientation> {
  // Observe the environment a session can actually use, based on its declaration.
  const { env, ...rest } = requested;
  const options: OrientOptions = runtime.refusedSessionOptions?.env === undefined && env !== undefined ? { ...rest, env } : rest;
  const budget = new ProbeBudget(until, options.signal);
  const installationReader = runtime.installation;
  const installation = await budget.run(installationReader === undefined ? undefined : async (): Promise<InstallationSnapshot> => { const result = await installationReader.call(runtime, options.env === undefined ? {} : { env: options.env }); return result; });
  if (installation.kind !== "ok" || installation.value.kind !== "available") { return absent(runtime, installation, options); }
  const available = installation.value;
  const authReader = runtime.authStatus, providersReader = runtime.providers;
  const local = options.depth === undefined || options.depth === "local";
  const [auth, providers] = await Promise.all([
    local && authReader !== undefined && authReader.localOnly !== true
      ? { kind: "skipped", because: "depth" } as const
      : budget.run(authReader === undefined ? undefined : async (timeoutMs): Promise<AuthStatus> => { const result = await authReader(available, { timeoutMs, ...(options.env === undefined ? {} : { env: options.env }) }); return result; }),
    providersReader === undefined ? undefined : budget.run(async (timeoutMs) => { const result = await providersReader(available, { resolve: options.depth === "account" || options.depth === "models", timeoutMs, ...(options.env === undefined ? {} : { env: options.env }) }); return result; }),
  ]);
  const extra = await additional(runtime, available, auth, options, budget, slots);
  return { id: runtime.id, brand: runtime.brand, installation, auth, ...(providers === undefined ? {} : { providers }), ...extra };
}

/** Combine native observations with bounded cost, without calling Runtime.session or submitting a prompt. */
export async function orient(registry: RuntimeRegistry, options: OrientOptions = {}): Promise<Orientation> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) { throw new RangeError("timeoutMs must be positive and fit a timer"); }
  const runtimes = options.runtimes === undefined ? registry.list() : [...new Set(options.runtimes)].map((id) => registry.require(id));
  const slots = new ProbeSlots();
  const until = Date.now() + timeoutMs;
  const results = await Promise.all(runtimes.map(async (runtime) => { const result = await readRuntime(runtime, options, until, slots); return result; }));
  return { observedAt: observedNow(), depth: options.depth ?? "local", runtimes: results };
}
