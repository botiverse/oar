import { expect, test } from "vitest";
import { UnsupportedOptionError, type Runtime, type Session, type SessionOptions } from "../packages/oar/src/index.js";
import { openWithRules } from "../apps/harbor/support.js";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- openWithRules only passes the session through.
const opened = {} as unknown as Session;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- openWithRules only passes the installation through.
const installation = {} as unknown as Parameters<Runtime["session"]>[0];
const base: SessionOptions = { cwd: "/work" };

function runtime(open: (options: SessionOptions) => Session, refused?: string): { runtime: Runtime; calls: SessionOptions[] } {
  const calls: SessionOptions[] = [];
  const standIn = {
    ...(refused === undefined ? {} : { refusedSessionOptions: { appendSystemPrompt: refused } }),
    session: async (_installation: unknown, options: SessionOptions) => {
      calls.push(options);
      return open(options);
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only session and refusedSessionOptions are read.
  return { runtime: standIn as unknown as Runtime, calls };
}

test("the rules go in the appended system prompt when the runtime takes it", async () => {
  const { runtime: accepting, calls } = runtime(() => opened);
  const result = await openWithRules(accepting, installation, base, "rules");
  expect(result).toEqual({ session: opened, rulesInPrompt: true });
  expect(calls).toEqual([{ cwd: "/work", appendSystemPrompt: "rules" }]);
});

test("a declared refusal opens once, without the prompt", async () => {
  const { runtime: declaring, calls } = runtime(() => opened, "no appended prompt");
  const result = await openWithRules(declaring, installation, base, "rules");
  expect(result).toEqual({ session: opened, rulesInPrompt: false, refusal: "no appended prompt" });
  expect(calls).toEqual([{ cwd: "/work" }]);
});

test("a refusal at open retries without the prompt and keeps the reason", async () => {
  const { runtime: refusing, calls } = runtime((options) => {
    if (options.appendSystemPrompt !== undefined) {
      throw new UnsupportedOptionError("appendSystemPrompt", "refused on resume");
    }
    return opened;
  });
  const result = await openWithRules(refusing, installation, base, "rules");
  expect(result).toEqual({ session: opened, rulesInPrompt: false, refusal: "refused on resume" });
  expect(calls).toHaveLength(2);
});

test("any other open failure is not retried", async () => {
  const { runtime: failing, calls } = runtime(() => {
    throw new UnsupportedOptionError("model", "unknown model");
  });
  await expect(openWithRules(failing, installation, base, "rules")).rejects.toThrow("unknown model");
  expect(calls).toHaveLength(1);
});
