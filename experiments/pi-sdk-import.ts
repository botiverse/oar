/**
 * FIRST CONTACT WITH THE BUNDLED PI SDK — proves the in-process import path.
 *
 * The pi runtime ships as an SDK dependency instead of a probed executable, so
 * the claim worth checking is not "a binary exists" but "this process can load
 * the SDK and reach its session entrypoint". A version string in package.json
 * cannot prove that; only an actual import can (ESM graph, wasm deps, exports
 * map all participate).
 *
 * Run: pnpm tsx experiments/pi-sdk-import.ts
 * Exits non-zero on any unmet expectation.
 *
 * ── OBSERVED 2026-08-21, @earendil-works/pi-coding-agent 0.84.2, linux x64 ──
 *
 * `import("@earendil-works/pi-coding-agent")` resolves through the package's
 * exports map (ESM-only: no `require` condition, which is why the runtime's
 * version walk uses `import.meta.resolve`, not `createRequire`). The module
 * exposes `createAgentSession` as a function. No network and no auth is needed
 * to load it; auth/model checks happen inside `createAgentSession` preflight.
 */
const sdk: unknown = await import("@earendil-works/pi-coding-agent");

if (typeof sdk !== "object" || sdk === null) {
  throw new Error("pi sdk did not load as a module namespace");
}
if (!("createAgentSession" in sdk) || typeof sdk.createAgentSession !== "function") {
  throw new Error("pi sdk does not expose createAgentSession");
}
process.stdout.write("pi sdk import ok: createAgentSession is callable\n");
