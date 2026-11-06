import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runTurn } from "./support/asserts.js";
import { dshEnabled, eventsOf, expectedDirectory, withDshFixture } from "./support/dsh-fixture.js";
import { alive, configuredMcp, mcp, mcpNames, mcpReply, trackedMcp } from "./support/dsh-mcp.js";
import { lastInput } from "./support/dsh-provider.js";
import { openTrace, record } from "../harness/trace.js";

describe.skipIf(!dshEnabled)("DSH session MCP", () => {
  test("native tools call through the invocation overlay, stay isolated, and must be supplied again on resume", async () => {
    openTrace("dsh-session-mcp");
    await withDshFixture(mcpReply, async ({ aimock, open, provider }) => {
      const patch = path.join(aimock.home, "cordis.patch.yml");
      const before = await readFile(patch);
      const tracked = await trackedMcp(aimock.cwd);
      const first = await open({ mcpServers: [{ ...tracked.server, env: {} }] });
      first.rawEvents(value => { record({ kind: "record", record: value }); });
      expect(await runTurn(first, "MCP:echo:FIRST")).toEqual({ kind: "completed" });
      const child = await tracked.read();
      expect(expectedDirectory(child.cwd)).toBe(expectedDirectory(aimock.cwd));
      expect(child.args).toEqual(["a b", "$(not-a-command)", ""]);
      expect(alive(child.pid)).toBe(true);
      const seen = eventsOf(first.records());
      expect(seen).toContainEqual(expect.objectContaining({ kind: "tool_call_started", tool: "mcp__echo__echo" }));
      expect(seen).toContainEqual(expect.objectContaining({ kind: "tool_call_ended", result: "ok", content: [{ type: "text", text: "echo:FIRST via=stdio token=none" }] }));
      const second = await open({ mcpServers: [mcp("other")] });
      expect(await runTurn(second, "MCP:other:SECOND")).toEqual({ kind: "completed" });
      const plain = await open();
      expect(await runTurn(plain, "PLAIN")).toEqual({ kind: "completed" });
      const names = (marker: string): readonly string[] => {
        const request = provider.requests.find(value => lastInput(value).includes(marker));
        assert.ok(request !== undefined);
        return mcpNames(request);
      };
      expect(names("FIRST")).toEqual(["mcp__configured__echo", "mcp__echo__echo"]);
      expect(names("SECOND")).toEqual(["mcp__configured__echo", "mcp__other__echo"]);
      expect(names("PLAIN")).toEqual(["mcp__configured__echo"]);
      await first.dispose();
      expect(alive(child.pid)).toBe(false);
      const resumed = await open({ resume: first.id, mcpServers: [mcp("fresh")] });
      expect(resumed.id).toBe(first.id);
      expect(await runTurn(resumed, "MCP:fresh:RESUPPLIED")).toEqual({ kind: "completed" });
      expect(names("RESUPPLIED")).toEqual(["mcp__configured__echo", "mcp__fresh__echo"]);
      expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain("echo:FIRST via=stdio token=none");
      await resumed.dispose();
      const omitted = await open({ resume: first.id });
      expect(await runTurn(omitted, "OMITTED")).toEqual({ kind: "completed" });
      expect(names("OMITTED")).toEqual(["mcp__configured__echo"]);
      await Promise.all([second.dispose(), plain.dispose(), omitted.dispose()]);
      expect(await readFile(patch)).toEqual(before);
    }, { homePatch: [configuredMcp] });
  }, 120_000);

  test("a missing server refuses startup before any model request", async () => {
    await withDshFixture(mcpReply, async ({ aimock, open, provider }) => {
      const tracked = await trackedMcp(aimock.cwd);
      await expect(open({ mcpServers: [tracked.server, { name: "missing", command: path.join(aimock.cwd, "does-not-exist"), args: [] }] })).rejects.toThrow();
      expect(provider.requests).toEqual([]);
      const child = await tracked.read();
      expect(alive(child.pid)).toBe(false);
      const next = await open();
      expect(await runTurn(next, "healthy after refusal")).toEqual({ kind: "completed" });
    });
  }, 90_000);

  test("a configured namespace collision refuses the open instead of replacing the user's server", async () => {
    await withDshFixture(mcpReply, async ({ aimock, open, provider }) => {
      const patch = path.join(aimock.home, "cordis.patch.yml");
      const before = await readFile(patch);
      await expect(open({ mcpServers: [mcp("configured")] })).rejects.toThrow(/already in use/u);
      expect(provider.requests).toEqual([]);
      expect(await readFile(patch)).toEqual(before);
    }, { homePatch: [configuredMcp] });
  }, 90_000);
});
