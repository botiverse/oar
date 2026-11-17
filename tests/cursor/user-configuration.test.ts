import assert from "node:assert/strict";
import { test } from "vitest";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";

for (const resume of [undefined, "agent-existing"]) {
  test.each([undefined, "include", "exclude"] as const)(`configuration %s reaches the SDK on ${resume === undefined ? "create" : "resume"}`, async (userConfiguration) => {
    const { session, opened } = await openFakeCursor({ model: "composer", ...(resume === undefined ? {} : { resume }), ...(userConfiguration === undefined ? {} : { userConfiguration }) });
    try {
      assert.deepEqual(opened, [{
        how: resume === undefined ? "create" : "resume",
        ...(resume === undefined ? {} : { id: resume }),
        options: { model: { id: "composer" }, local: { cwd: "/w", settingSources: userConfiguration === "exclude" ? [] : ["project", "user"], sandboxOptions: { enabled: false } } },
      }]);
    } finally { await session.dispose(); }
  });
}
