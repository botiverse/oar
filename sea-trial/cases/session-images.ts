import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import type { TrialCase } from "../harness/runner.js";

/** A 32×32 PNG; Grok drops images smaller than 8×8. */
const IMAGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";

export const sessionImagesCases: readonly TrialCase[] = [
  {
    // Images travel with the input as the runtime's own image content: the
    // request records their paths (never the bytes), and an input whose image
    // cannot go is refused whole, before anything reaches the runtime, so the
    // session stays idle and the caller still owns the input.
    id: "session.images-travel-with-input",
    requires: ["installation", "session"],
    async run(subject) {
      const dir = await mkdtemp(path.join(tmpdir(), "oar-images-"));
      const image = path.join(dir, "dot.png");
      await writeFile(image, Buffer.from(IMAGE_PNG, "base64"));
      const session = await subject.startSession();
      try {
        for (const control of [session.prompt.bind(session), session.steer?.bind(session), session.queue.bind(session)]) {
          if (control === undefined) { continue; }
          const empty = await control("");
          assert.deepEqual(empty.response.body, { kind: "rejected", code: "unsupported", reason: "empty input: give text or images" });
        }
        if (!session.capabilities.images) {
          const refused = await session.prompt("what is this?", { images: [{ path: image }] });
          assert.ok(refused.kind === "rejected" && refused.code === "unsupported", `no image input means unsupported: ${JSON.stringify(refused.response.body)}`);
          assert.equal(session.status().value.kind, "idle");
          return;
        }
        const missing = await session.prompt("what is this?", { images: [{ path: path.join(dir, "missing.png") }] });
        assert.ok(missing.kind === "rejected" && missing.code === "error", `an unreadable image refuses the input: ${JSON.stringify(missing.response.body)}`);
        const notImage = await session.prompt("what is this?", { images: [{ path: path.join(dir, "notes.txt") }] });
        assert.ok(notImage.kind === "rejected" && notImage.code === "unsupported", `a file that is not an image refuses the input: ${JSON.stringify(notImage.response.body)}`);
        assert.equal(session.status().value.kind, "idle", "a refused input starts no turn");
        const started = await session.prompt("", { images: [{ path: image }] });
        assert.equal(started.kind, "accepted", JSON.stringify(started.response.body));
        assert.ok(started.request.body.kind === "prompt");
        assert.equal(started.request.body.input, "", "image-only input stays empty in the record");
        assert.deepEqual(started.request.body.images, [{ path: image }], "the request records the image paths verbatim");
        assert.deepEqual(await awaitTurnEnd(session, started.request.seq), { kind: "completed" });
      } finally {
        await session.dispose();
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      }
    },
  },
];
