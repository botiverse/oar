import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { createCursorRuntime } from "../../packages/oar/src/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { bundled, lastResult, printEnvironment, tempDirectory } from "../fixtures/cursor-subprocess.js";

/*
 * What the child adds to its environment before it imports the SDK: the
 * native companion paths, resolved from `sdkModule` the way
 * `cursorNativeEnvironment()` resolves them, unless the environment has
 * them; and `ELECTRON_RUN_AS_NODE` put back to the environment's own value.
 * The fake SDK module is copied next to a stand-in companion package, so
 * the child resolves it from there.
 */

afterEach(() => { vi.unstubAllEnvs(); });

const NAMES = ["CURSOR_TREE_SITTER_VENDOR_DIR", "CURSOR_RIPGREP_PATH", "ELECTRON_RUN_AS_NODE"];

/** A directory with the fake SDK module and a companion package for this platform beside it; its module URL. */
function sdkWithCompanion(): { readonly sdkModule: string; readonly companion: string } {
  const root = tempDirectory();
  const companion = path.join(root, "node_modules", "@cursor", `sdk-${process.platform}-${process.arch}`);
  mkdirSync(companion, { recursive: true });
  writeFileSync(path.join(companion, "package.json"), "{}");
  const module = path.join(root, "sdk.mjs");
  copyFileSync(path.join(import.meta.dirname, "../fixtures/fake-cursor-sdk-module.mjs"), module);
  return { sdkModule: pathToFileURL(module).href, companion };
}

async function seen(sdkModule: string, env: Readonly<Record<string, string>>): Promise<unknown> {
  const runtime = createCursorRuntime({ execution: "subprocess", sdkModule, envBase: "clean" });
  const session = await runtime.session(bundled, { cwd: tempDirectory(), env });
  try {
    const prompt = await session.prompt(`shell:${printEnvironment(NAMES)}`);
    await awaitTurnEnd(session, prompt.seq);
    const result = lastResult(session);
    return typeof result === "string" ? JSON.parse(result) : result;
  } finally {
    await session.dispose();
  }
}

test("the child sets the companion paths from sdkModule, and takes away the ELECTRON_RUN_AS_NODE that started it", async () => {
  const { sdkModule, companion } = sdkWithCompanion();
  const rg = path.join(companion, "bin", process.platform === "win32" ? "rg.exe" : "rg");
  expect(await seen(sdkModule, {})).toEqual([path.join(companion, "vendor"), rg, null]);
});

test("paths and an ELECTRON_RUN_AS_NODE the environment sets are kept", async () => {
  const { sdkModule } = sdkWithCompanion();
  expect(await seen(sdkModule, { CURSOR_TREE_SITTER_VENDOR_DIR: "/host/vendor", CURSOR_RIPGREP_PATH: "/host/rg", ELECTRON_RUN_AS_NODE: "host-value" }))
    .toEqual(["/host/vendor", "/host/rg", "host-value"]);
});
