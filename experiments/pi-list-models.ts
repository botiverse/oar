/**
 * PI MODEL LIST — pins `pi --list-models` as the live registry, not a catalog.
 *
 * Pi has no `pi models` subcommand; listing is the `--list-models` flag. The
 * output is a human table (provider, model, context, max-out, thinking,
 * images) of the LIVE ModelRegistry — i.e. models usable right now, not a
 * static catalog. There is no JSON output variant (`--mode json` has no
 * effect on this flag), so a consumer must parse the table or go in-process
 * via the SDK.
 *
 * Run: unset PI_PACKAGE_DIR && pnpm tsx experiments/pi-list-models.ts
 * Exits non-zero on any unmet expectation. No tokens consumed.
 *
 * ── OBSERVED 2026-09-04, pi (local install), linux x64 ──
 *
 * Registry population is dynamic: in this environment ~/.pi/agent/auth.json
 * and models-store.json are both empty `{}`, yet the table lists exe-dev-*
 * providers — because the exe-dev extension
 * (~/.pi/agent/extensions/exe-dev/index.ts, "Reflection-discovered
 * integrations are the sole source of models and provider routes") calls
 * `pi.registerProvider`/`unregisterProvider` at runtime and reads
 * `ctx.modelRegistry.getAll()`. Unconfigured base providers (anthropic,
 * openai, ...) do NOT appear. So the list is credential/config-scoped AND
 * volatile — extensions can register/unregister providers between calls; a
 * unified contract needs re-query semantics, not a cached snapshot.
 *
 * Auth readiness is a SEPARATE, differently-scoped surface:
 * `pi auth check --provider <p> --json --no-refresh` returns typed JSON — for
 * an extension-registered provider it says
 * `{"status":"not_ready","reason":"provider_not_found"}` (auth check does not
 * see runtime-registered providers) while unconfigured base providers give
 * `credentials_not_configured`. Typed readiness exists (guardrail: never
 * conflate "not logged in" with an empty list), but its provider view and
 * --list-models' provider view do not coincide.
 *
 * ── OBSERVED 2026-09-05, in-process via @earendil-works/pi-coding-agent 0.84.2 ──
 *
 * `ModelRuntime.create({ refreshOnCreate: false })` starts with an EMPTY
 * availability snapshot: `getAvailableSnapshot()` (which is all
 * `ModelRegistry.getAvailable()` returns) stays `[]` until an availability
 * refresh runs. `await runtime.getAvailable()` runs that refresh and then
 * returns the usable-now list — this is what `pi --list-models` itself awaits
 * (packages/coding-agent/src/cli/list-models.ts). With a dummy XAI_API_KEY the
 * snapshot is 0 before and 4 after; the check is offline for API-key providers
 * (any key present counts). This is one half of `oar models pi` printing
 * "no models" while `pi --list-models` listed twenty (fixed the same day).
 *
 * The other half: a bare `ModelRuntime.create()` never sees extension-
 * registered providers. `pi --list-models` (dist/main.js) first calls
 * `createAgentSessionServices(...)`, whose resource loader loads the
 * extensions and applies their `registerProvider` calls to the ModelRuntime,
 * and only then awaits `getAvailable()`. Here (auth.json `{}`, every provider
 * from the exe-dev extension) the bare runtime lists 0 providers with no key,
 * the services runtime lists the same provider set as the `pi --list-models`
 * table (58 rows, 4 exe-dev-* providers) in ~1.8 s with empty diagnostics.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const env = { ...process.env };
delete env.PI_PACKAGE_DIR;

// Like execFileSync but a non-zero exit still yields stdout — `pi auth check`
// exits non-zero for not_ready while printing its typed JSON.
function runCapturingStdout(command: string, argv: string[]): string {
  try {
    return execFileSync(command, argv, { env, encoding: "utf8" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "stdout" in error) {
      const { stdout } = error;
      if (typeof stdout === "string") {
        return stdout;
      }
    }
    throw new Error(`${command} ${argv.join(" ")} failed without stdout`, {
      cause: error,
    });
  }
}

const table = runCapturingStdout("pi", ["--list-models"]);
const lines = table.split("\n").filter((line) => line.trim() !== "");
assert.ok(lines.length > 1, "expected a header plus at least one model row");
const header = (lines[0] ?? "").toLowerCase();
assert.ok(header.includes("provider"), `no provider column in: ${header}`);
assert.ok(header.includes("model"), `no model column in: ${header}`);

// Typed auth readiness for a base provider that is not configured here.
const authRaw = runCapturingStdout(
  "pi",
  ["auth", "check", "--provider", "anthropic", "--json", "--no-refresh"],
);
const auth: unknown = JSON.parse(authRaw);
assert.ok(
  typeof auth === "object" && auth !== null && "status" in auth,
  "auth check did not return typed JSON with a status field",
);

// In-process: the snapshot is empty until getAvailable() computes it.
process.env.XAI_API_KEY ??= "dummy-not-a-real-key";
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const runtime = await ModelRuntime.create({ refreshOnCreate: false });
const snapshotBefore = runtime.getAvailableSnapshot().length;
assert.equal(snapshotBefore, 0, "snapshot should be empty before any refresh");
const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(15_000) });
assert.ok(
  available.some((model) => model.provider === "xai"),
  "getAvailable() should list the API-key provider that has a key set",
);
const snapshotAfter = runtime.getAvailableSnapshot().length;
assert.equal(snapshotAfter, available.length, "getAvailable() should populate the snapshot");

const rows = lines.slice(1);
const providerColumn = rows.map((line) => line.trim().split(/\s+/u)[0] ?? "");
const providers = [...new Set(providerColumn)];

// Services path (what `pi --list-models` really builds): extensions loaded, so
// extension-registered providers appear. Must match the CLI table's provider
// set; the bare runtime above only knows the dummy-key provider.
const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
const services = await createAgentSessionServices({
  cwd: process.cwd(),
  modelRuntimeSignal: AbortSignal.timeout(15_000),
  resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
});
const viaServices = await services.modelRuntime.getAvailable(undefined, {
  signal: AbortSignal.timeout(15_000),
});
// The dummy XAI_API_KEY set above was not in the CLI run's environment, so
// the services set is the CLI set plus (at most) that one provider.
const byName = (a: string, b: string): number => a.localeCompare(b);
const servicesProviders = [...new Set(viaServices.map((model) => model.provider))].toSorted(byName);
const cliProviders = providers.toSorted(byName);
assert.deepEqual(
  servicesProviders.filter((provider) => provider !== "xai"),
  cliProviders.filter((provider) => provider !== "xai"),
  "services-path providers should equal the pi --list-models provider set",
);
const bareProviders = [...new Set(available.map((model) => model.provider))].toSorted(byName);

process.stdout.write(`${JSON.stringify({
  modelRows: rows.length,
  providers,
  baseProviderAuth: auth,
  inProcess: { snapshotBefore, available: available.length, snapshotAfter, bareProviders },
  viaServices: {
    available: viaServices.length,
    providers: servicesProviders,
    diagnostics: services.diagnostics,
  },
}, null, 2)}\n`);
