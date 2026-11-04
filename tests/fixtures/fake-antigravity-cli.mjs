/* oxlint-disable typescript/no-unsafe-member-access, typescript/no-unsafe-call -- Standalone untyped child-process fixture. */
import process from "node:process";
// Exercise the real adapter's argv, then reuse the existing ACP protocol fixture.
if (process.argv[2] === "--version") {
  process.stdout.write("1.4.12\n");
} else if (process.argv[2] === "acp") {
  process.argv.splice(2, process.argv.length - 2, "antigravity");
  await import("./fake-acp-agent.mjs");
} else {
  process.stderr.write("Expected agy acp\n");
  process.exitCode = 2;
}
