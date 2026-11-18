import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { formatMessage } from "../apps/harbor/support.js";
import { mentionsIn, parseAgentEnv, parseAgentSpec, Store } from "../apps/harbor/store.js";

test("agent specs name a runtime, an optional model and an optional agent name", () => {
  expect(parseAgentSpec("claude")).toEqual({ name: "claude", runtime: "claude" });
  expect(parseAgentSpec("agy=antigravity:hydrogen")).toEqual({ name: "agy", runtime: "antigravity", model: "hydrogen" });
  expect(parseAgentSpec("c=codex:gpt-5.5:fast")).toEqual({ name: "c", runtime: "codex", model: "gpt-5.5:fast" });
  expect(() => parseAgentSpec("bad name=claude")).toThrow(/bad agent spec/u);
  expect(() => parseAgentSpec("x=")).toThrow(/bad agent spec/u);
});

test("mentions are @name tokens, not email addresses or doubled @", () => {
  expect(mentionsIn("@claude and @codex-2, cc @all")).toEqual(["claude", "codex-2", "all"]);
  expect(mentionsIn("mail a@b.c or @@x")).toEqual([]);
});

test("the channel numbers messages across store instances and the journal appends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-store-"));
  try {
    const one = new Store(dir).post("qa", "@claude hi", ["claude"]);
    new Store(dir).journal({ agent: "claude", kind: "delivered", seqs: [one.seq] });
    const second = new Store(dir);
    expect([one.seq, second.post("claude", "@qa hello", []).seq]).toEqual([1, 2]);
    expect(second.messages().map((message) => message.text)).toEqual(["@claude hi", "@qa hello"]);
    expect(second.entries()).toMatchObject([{ agent: "claude", kind: "delivered", seqs: [1] }]);
    expect(formatMessage(one)).toMatch(/^\[harbor msg=1 time=\S+Z from=@qa\] @claude hi$/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--agent-env entries group by agent and keep values verbatim", () => {
  const env = parseAgentEnv(["oc1:OAR_OPENCODE_BIN=/a/b/opencode", "oc1:XDG_DATA_HOME=/x=y", "oc2:OAR_OPENCODE_BIN=/c"]);
  expect(Object.fromEntries(env)).toEqual({ oc1: { OAR_OPENCODE_BIN: "/a/b/opencode", XDG_DATA_HOME: "/x=y" }, oc2: { OAR_OPENCODE_BIN: "/c" } });
  expect(() => parseAgentEnv(["no-colon"])).toThrow(/bad --agent-env/u);
});
