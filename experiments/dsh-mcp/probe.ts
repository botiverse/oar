import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runTurn } from "../../sea-trial/vendor/support/asserts.js";
import { eventsOf, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { mcp, mcpNames, mcpReply } from "../../sea-trial/vendor/support/dsh-mcp.js";

// All routes are synthetic loopback providers. Prints selected results, never home paths or account data.
await withDshFixture(mcpReply, async ({ open, aimock, provider, installation }) => {
  assert.ok(installation.via === "executable");
  const patch = path.join(aimock.home, "cordis.patch.yml");
  const before = await readFile(patch, "utf8");
  const first = await open({ mcpServers: [mcp("echo")] });
  const initial = await runTurn(first, "MCP:echo:FIRST");
  const firstNames = mcpNames(provider.requests[0] ?? { body: {}, messages: [] });
  const toolEvents = eventsOf(first.records()).filter(event => event.kind === "tool_call_started" || event.kind === "tool_call_ended");
  await first.dispose();
  const resumed = await open({ resume: first.id, mcpServers: [mcp("fresh")] });
  const resume = await runTurn(resumed, "MCP:fresh:RESUMED");
  const resumeNames = mcpNames(provider.requests.at(-1) ?? { body: {}, messages: [] });
  await resumed.dispose();
  const omitted = await open({ resume: first.id });
  const omit = await runTurn(omitted, "NO_SESSION_MCP");
  const omittedNames = mcpNames(provider.requests.at(-1) ?? { body: {}, messages: [] });
  await omitted.dispose();
  assert.deepEqual([initial, resume, omit], [{ kind: "completed" }, { kind: "completed" }, { kind: "completed" }]);
  assert.deepEqual([firstNames, resumeNames, omittedNames], [["mcp__echo__echo"], ["mcp__fresh__echo"], []]);
  const unchanged = before === await readFile(patch, "utf8");
  assert.ok(unchanged);
  console.log(JSON.stringify({ version: installation.version, initial, firstNames, toolEvents, resume, resumeNames, omit, omittedNames, userPatchUnchanged: unchanged }, null, 2));
});
