import { expect, test, vi } from "vitest";

// #328 (Lookout): a host may leave Bedrock out of its bundle. The sign-in
// flows are still handed over, the failure warns once, nothing throws, and
// the next call tries again.
const registered = vi.hoisted(() => ({ flows: 0, bedrock: 0, missing: true }));
vi.mock("@earendil-works/pi-ai/bun-oauth", () => ({ registerBunOAuthFlows: () => { registered.flows += 1; } }));
vi.mock("@earendil-works/pi-ai/bedrock-provider", () => {
  if (registered.missing) { throw new Error("Cannot find package '@earendil-works/pi-ai'"); }
  return { bedrockProviderModule: {} };
});
vi.mock("@earendil-works/pi-ai/compat", () => ({ setBedrockProviderModule: () => { registered.bedrock += 1; } }));
const { providePiModules } = await import("../../packages/oar/src/runtimes/pi/static-modules.js");

test("a module the host left out warns once and is tried again; the others are handed over", async () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  try {
    await expect(providePiModules()).resolves.toBeUndefined();
    await expect(providePiModules()).resolves.toBeUndefined();
    expect(registered).toMatchObject({ flows: 2, bedrock: 0 });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[1]).toEqual({ code: "OAR_PI_MODULES" });
  } finally {
    warning.mockRestore();
  }
});
