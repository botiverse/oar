import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { CURSOR_SDK_VERSION } from "../../packages/oar/src/runtimes/cursor/sdk-version.js";

test("Cursor's required SDK version matches OAR's published peer dependency", () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../packages/oar/package.json", import.meta.url), "utf8"));
  const peers = asRecord(asRecord(manifest)?.peerDependencies);
  expect(CURSOR_SDK_VERSION).toBe(peers?.["@cursor/sdk"]);
});
