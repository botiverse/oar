/* oxlint-disable max-statements -- Exercise setup, observation failure and actual resource cleanup in one guarded regression. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { preservingProbeEvidence, probeErrorText, probeFixture, usingProbeFixture } from "../experiments/sharing/fixture-lifetime.js";

it.each(["setup", "configuration evidence", "MCP journal"])("cleans native process, mock server and HOME when %s throws", async (stage) => {
  const home = await mkdtemp(path.join(tmpdir(), "oar-sharing-lifetime-"));
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const state = { stopped: false };
  const failure = new Error(stage);
  const create = async () => probeFixture(async (defer) => {
    defer(async () => { await rm(home, { recursive: true, force: true }); });
    defer(async () => { const closed = once(server, "close"); server.close(); await closed; });
    defer(async () => { const exited = once(child, "exit"); child.kill(); await exited; state.stopped = true; });
    if (stage === "setup") { throw failure; }
    return { evidence: (): never => { throw failure; } };
  });
  try {
    await expect(usingProbeFixture(create, async (fixture) => { fixture.evidence(); })).rejects.toBe(failure);
    expect(state.stopped).toBe(true);
    expect(server.listening).toBe(false);
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    // A regression in ownership must not leak this test's deliberately live resources.
    if (!state.stopped) { child.kill(); }
    if (server.listening) { server.close(); }
    await rm(home, { recursive: true, force: true });
  }
});

it("continues cleaning earlier resources when a later cleanup fails", async () => {
  const released: string[] = [];
  const fixture = await probeFixture(async (defer) => {
    defer(async () => { released.push("home"); });
    defer(async () => { released.push("mock"); });
    defer(async () => { released.push("process"); throw new Error("native cleanup failed"); });
    return {};
  });
  await expect(fixture.stop()).rejects.toThrow("Probe cleanup failed");
  expect(released).toEqual(["process", "mock", "home"]);
  await expect(fixture.stop()).rejects.toThrow("Probe cleanup failed");
  expect(released).toHaveLength(3);
});

it("retains observation, every evidence failure and cleanup failure together", async () => {
  const attempted: string[] = [];
  const observation = new Error("native observation failed");
  const evidence = new Error("configuration evidence failed");
  const journal = new Error("MCP journal failed");
  const cleanup = new Error("native stop failed");
  const result = usingProbeFixture(async () => ({ stop: async () => { attempted.push("stop"); throw cleanup; } }), async () => {
    await preservingProbeEvidence(async () => { throw observation; }, [
      () => { attempted.push("configuration"); throw evidence; },
      () => { attempted.push("journal"); throw journal; },
      () => { attempted.push("native frames"); },
    ]);
  });
  const caught: unknown = await result.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(AggregateError);
  assert.ok(caught instanceof AggregateError);
  expect(caught.errors[1]).toBe(cleanup);
  const nested: unknown = caught.errors[0];
  assert.ok(nested instanceof AggregateError);
  expect(nested.errors).toEqual([observation, evidence, journal]);
  expect(probeErrorText(caught)).toContain(observation.message);
  expect(probeErrorText(caught)).toContain(evidence.message);
  expect(probeErrorText(caught)).toContain(journal.message);
  expect(probeErrorText(caught)).toContain(cleanup.message);
  expect(attempted).toEqual(["configuration", "journal", "native frames", "stop"]);
});

it("preserves the original error when observation alone fails", async () => {
  const error = new Error("original observation");
  let collected = false;
  await expect(preservingProbeEvidence(async () => { throw error; }, [() => { collected = true; }])).rejects.toBe(error);
  expect(collected).toBe(true);
});

it("also stops when an observer throws before returning a promise", async () => {
  const error = new Error("synchronous observer failure");
  let stopped = false;
  await expect(usingProbeFixture(async () => ({ stop: async () => { stopped = true; } }), () => { throw error; })).rejects.toBe(error);
  expect(stopped).toBe(true);
});
