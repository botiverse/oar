import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { bottegaOpenFields, bottegaRefusedSessionOptions } from "../../packages/oar/src/runtimes/bottega/options.js";
import { bottegaRuntime } from "../../packages/oar/src/runtimes/bottega/index.js";

test("a model is provider/model, and the model id keeps its own slashes", () => {
  expect(bottegaOpenFields({ model: "openrouter/deepseek/deepseek-v4.1-flash" })).toEqual({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" });
  expect(bottegaOpenFields({})).toEqual({});
  for (const model of ["faux", "/faux", "faux/"]) {
    expect(() => bottegaOpenFields({ model })).toThrow(UnsupportedOptionError);
  }
});

test("effort is bottega's reasoning level in its own spelling; another is refused, never substituted", () => {
  expect(bottegaOpenFields({ effort: "xhigh" })).toEqual({ thinking: "xhigh" });
  expect(() => bottegaOpenFields({ effort: "galactic" })).toThrow(/no reasoning level "galactic"/u);
});

test("the host's standing text is appended; replacing bottega's own prompt is refused before anything starts", async () => {
  expect(bottegaOpenFields({ appendSystemPrompt: "You answer to Lin." })).toEqual({ instructions: "You answer to Lin." });
  const runtime = bottegaRuntime;
  expect(runtime.refusedSessionOptions).toBe(bottegaRefusedSessionOptions);
  expect(runtime.execution).toBe("process");
  await expect(runtime.session({ kind: "available", via: "executable", command: "/nonexistent/bottega" }, { cwd: process.cwd(), systemPrompt: "replace" }))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "systemPrompt" });
});
