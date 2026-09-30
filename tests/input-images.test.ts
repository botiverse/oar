import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { InputImage } from "../packages/oar/src/index.js";
import { withInputImages, type LoadedImage } from "../packages/oar/src/kernel.js";

/** What `withInputImages` hands the delivery, or its refusal. */
const load = (capabilities: { images: boolean }, images: readonly InputImage[] | undefined): unknown =>
  withInputImages(capabilities, images, (loaded: readonly LoadedImage[]) => ({ kind: "accepted", native: loaded }));

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "oar-input-images-"));
  await writeFile(path.join(dir, "shot.PNG"), Buffer.from("png bytes"));
  await writeFile(path.join(dir, "shot"), Buffer.from("jpeg bytes"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("no images is always fine, even without image input", () => {
  expect(load({ images: false }, undefined)).toEqual({ kind: "accepted", native: [] });
  expect(load({ images: false }, [])).toEqual({ kind: "accepted", native: [] });
});

test("images are read as base64 with their type, from the extension or as given", () => {
  const loaded = load({ images: true }, [
    { path: path.join(dir, "shot.PNG") },
    { path: path.join(dir, "shot"), mediaType: "image/jpeg" },
  ]);
  expect(loaded).toEqual({ kind: "accepted", native: [
    { path: path.join(dir, "shot.PNG"), mediaType: "image/png", data: Buffer.from("png bytes").toString("base64") },
    { path: path.join(dir, "shot"), mediaType: "image/jpeg", data: Buffer.from("jpeg bytes").toString("base64") },
  ] });
});

test("an input whose images can't go is refused whole", () => {
  const image = { path: path.join(dir, "shot.PNG") };
  expect(load({ images: false }, [image])).toMatchObject({ kind: "rejected", code: "unsupported" });
  expect(load({ images: true }, [image, { path: path.join(dir, "shot") }])).toMatchObject({ kind: "rejected", code: "unsupported" });
  expect(load({ images: true }, [{ path: path.join(dir, "gone.png") }])).toMatchObject({ kind: "rejected", code: "error" });
  expect(load({ images: true }, [{ path: path.join(dir, "shot"), mediaType: "image/tiff" }])).toMatchObject({ kind: "rejected", code: "unsupported" });
});
