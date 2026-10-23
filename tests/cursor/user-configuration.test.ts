import assert from "node:assert/strict";
import { test } from "vitest";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";

test("exclude explicitly disables native setting sources and overrides the user sandbox setting", async () => {
  const { session, opened } = await openFakeCursor({ model: "composer", userConfiguration: "exclude" });
  assert.deepEqual(opened, [{ how: "create", options: { model: { id: "composer" }, local: { cwd: "/w", settingSources: [], sandboxOptions: { enabled: false } } } }]);
  await session.dispose();
});
