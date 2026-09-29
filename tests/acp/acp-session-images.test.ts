import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { fixture, start } from "../fixtures/acp-session-support.js";

let dir = "";
let image = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "oar-acp-images-"));
  image = path.join(dir, "shot one.png");
  await writeFile(image, Buffer.from("png"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("an agent that advertises image prompts gets each image as an image block before the text", async () => {
  const session = await start();
  expect(session.capabilities.images).toBe(true);
  const run = await promptAndWait(session, "look", { images: [{ path: image }] });
  expect(run.kind === "ended" && run.text).toBe(`echo:[image image/png ${pathToFileURL(image).href}] look`);
  const queued = await session.queue("again", { images: [{ path: image }] });
  expect(queued.kind).toBe("accepted");
  await session.dispose();
});

test("an agent without image prompts refuses an input with images, unsupported, and sends nothing", async () => {
  const session = await start({ args: [fixture, "no-images"] });
  expect(session.capabilities.images).toBe(false);
  const refused = await session.prompt("look", { images: [{ path: image }] });
  expect(refused.response.body).toMatchObject({ kind: "rejected", code: "unsupported" });
  expect(session.status().value.kind).toBe("idle");
  const queued = await session.queue("look", { images: [{ path: image }] });
  expect(queued.response.body).toMatchObject({ kind: "rejected", code: "unsupported" });
  await session.dispose();
});
