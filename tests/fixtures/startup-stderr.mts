// Stand-in for a CLI refusing its startup arguments before it can answer a request.
if (process.env.OAR_DIAGNOSTIC_FRAME === "first") {
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "fixture" })}\n`);
}
process.stderr.write(`${"opaque-leading-fragment".repeat(440)}\nstartup refused: ${process.env.FIXTURE_TOKEN ?? ""} sk-diagnostic-only-1234567890\n`);
process.exitCode = 1;
