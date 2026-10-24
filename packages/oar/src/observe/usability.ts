import type { Orientation, RuntimeOrientation, RuntimeUsability, UnusableReason, UsabilityOptions } from "../contracts/orientation.js";

interface Version { readonly numbers: readonly number[]; readonly prerelease: readonly string[] }
function version(value: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/u.exec(value);
  return match === null ? undefined : { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) { return Number(left.length === 0) - Number(right.length === 0); }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index], b = right[index];
    if (a === b) { continue; }
    if (a === undefined || b === undefined) { return a === undefined ? -1 : 1; }
    const an = /^\d+$/u.test(a), bn = /^\d+$/u.test(b);
    if (an && bn) { return Number(a) - Number(b); }
    if (an !== bn) { return an ? -1 : 1; }
    return a < b ? -1 : 1;
  }
  return 0;
}

function reaches(actual: string | undefined, minimum: Version): boolean {
  const parsed = actual === undefined ? undefined : version(actual);
  if (parsed === undefined) { return false; }
  for (let index = 0; index < 3; index += 1) {
    const difference = (parsed.numbers[index] ?? 0) - (minimum.numbers[index] ?? 0);
    if (difference !== 0) { return difference > 0; }
  }
  return comparePrerelease(parsed.prerelease, minimum.prerelease) >= 0;
}

function installationReason(runtime: RuntimeOrientation, minimum: Version | undefined): UnusableReason | undefined {
  const installation = runtime.installation;
  if (installation.kind === "failed" || installation.kind === "timed_out") { return "probe_failed"; }
  if (installation.kind !== "ok") { return "probe_failed"; }
  if (installation.value.kind === "not_found") { return "not_installed"; }
  if (installation.value.kind !== "available") { return "probe_failed"; }
  if (minimum !== undefined && !reaches(installation.value.via === "executable" ? installation.value.version : undefined, minimum)) { return "version_unsupported"; }
  return undefined;
}

function accountReason(runtime: RuntimeOrientation): UnusableReason | undefined {
  const usage = runtime.accountUsage;
  if (usage?.kind === "ok" && usage.value.kind === "available" && usage.value.rateLimited) { return "rate_limited"; }
  if (usage?.kind === "ok" && usage.value.kind === "reauth_required") { return "logged_out"; }
  if (runtime.models?.kind === "skipped" && runtime.models.because === "logged_out") { return "logged_out"; }
  if (runtime.auth.kind === "ok") {
    if (runtime.auth.value.kind === "logged_in") { return undefined; }
    if (runtime.auth.value.kind === "logged_out") { return "logged_out"; }
  }
  if (runtime.providers?.kind === "ok" && runtime.providers.value.some((provider) => provider.configured)) { return undefined; }
  if ([runtime.auth.kind, runtime.providers?.kind].some((kind) => kind === "failed" || kind === "timed_out")) { return "probe_failed"; }
  // A provider list omits credentials configured only in the environment.
  return "auth_unknown";
}

/** Conservative host-side readiness policy over current facts; no remote login guarantee or ordering. */
export function usability(orientation: Orientation, options: UsabilityOptions = {}): readonly RuntimeUsability[] {
  const minima = new Map(Object.entries(options.minVersions ?? {}).map(([id, value]) => {
    const parsed = version(value);
    if (parsed === undefined) { throw new RangeError(`Invalid minimum version for ${id}`); }
    return [id, parsed] as const;
  }));
  return orientation.runtimes.map((runtime) => {
    const because = installationReason(runtime, minima.get(runtime.id)) ?? accountReason(runtime);
    return { id: runtime.id, usable: because === undefined, ...(because === undefined ? {} : { because }) };
  });
}
