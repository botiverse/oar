import { expect, test } from "vitest";
import { join } from "node:path";
import {
  piFindSessionFile,
  piResolveModel,
  piSessionDir,
  splitPiModelId,
} from "../../packages/oar/src/runtimes/pi/resolve.js";

// pi (SDK 0.84.2) keeps sessions as files under <agentDir>/sessions/--<cwd
// slug>--; the adapter mirrors that unexported formula so OAR_PI_AGENT_DIR
// and pi's own CLI agree on where a cwd's sessions live.
test("piSessionDir mirrors pi's per-cwd session directory formula", () => {
  expect(piSessionDir("/home/me/proj", "/home/me/.pi/agent")).toBe(
    join("/home/me/.pi/agent", "sessions", "--home-me-proj--"),
  );
});

test("piFindSessionFile returns the file whose header id matches", async () => {
  const lister = {
    list: async (): Promise<{ id: string; path: string }[]> => [
      { id: "other", path: "/dir/other.jsonl" },
      { id: "abc-123", path: "/dir/abc.jsonl" },
    ],
  };
  await expect(piFindSessionFile(lister, "abc-123", "/proj", "/dir")).resolves.toBe("/dir/abc.jsonl");
});

// Resume failure names the id, the directory searched, and why a session
// might legitimately be missing (pi writes the file on the first message).
test("piFindSessionFile explains a resume id with no session file", async () => {
  const lister = { list: async (): Promise<{ id: string; path: string }[]> => [{ id: "other", path: "/dir/o.jsonl" }] };
  await expect(piFindSessionFile(lister, "missing-id", "/proj", "/dir/sessions/--proj--")).rejects.toThrow(
    /pi session missing-id not found: no session file with that id under \/dir\/sessions\/--proj-- \(1 session\(s\) there for cwd \/proj; pi persists a session on its first message\)/u,
  );
});

test("splitPiModelId splits provider/model at the first slash only", () => {
  expect(splitPiModelId("openrouter/anthropic/claude-sonnet-4")).toEqual({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
  });
});

test("splitPiModelId rejects a bare model id with the expected spelling", () => {
  expect(() => splitPiModelId("grok-4")).toThrow(
    'pi model must be spelled provider/model as listed by `oar models pi`; got "grok-4"',
  );
  expect(() => splitPiModelId("xai/")).toThrow(/provider\/model/u);
});

test("piResolveModel returns the ModelRuntime entry for provider/model", () => {
  const model = { provider: "xai", id: "grok-4" };
  const lookup = {
    getModel: (provider: string, modelId: string): typeof model | undefined =>
      provider === "xai" && modelId === "grok-4" ? model : undefined,
  };
  expect(piResolveModel(lookup, "xai/grok-4")).toBe(model);
});

// Unknown models are an error, not a silent fallback to pi's default.
test("piResolveModel explains an unregistered model and points at the list", () => {
  const lookup = { getModel: (): { id: string } | undefined => undefined };
  expect(() => piResolveModel(lookup, "xai/grok-9")).toThrow(
    "pi model xai/grok-9 is not registered: provider xai has no model grok-9 (see `oar models pi` for the usable list)",
  );
});
