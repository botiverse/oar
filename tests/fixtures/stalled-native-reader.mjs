/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- Standalone untyped Node fixture. */
// Only the version and account preflights needed to reach the selected query answer.
if (process.argv.includes("--version") && typeof process.env.OAR_FIXTURE_VERSION === "string") {
  process.stdout.write(process.env.OAR_FIXTURE_VERSION);
  process.exit(0);
}
if (process.argv.includes("status") && process.env.OAR_FIXTURE_QODER === "1") {
  process.stdout.write('{"logged_in":true}');
  process.exit(0);
}
await import("./agent-tree.mjs");
// The real fixture tree holds the event loop open even when an SDK import never finishes.
await Promise.withResolvers().promise;
