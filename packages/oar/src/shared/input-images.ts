import { accessSync, constants, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { InputImage, ResponseBody, SessionCapabilities } from "../contracts/session.js";

/** An input image read for delivery: the bytes a runtime that takes data (claude, ACP, pi) sends, base64. */
export interface LoadedImage {
  readonly path: string;
  readonly mediaType: string;
  readonly data: string;
}

type Rejected = Extract<ResponseBody, { kind: "rejected" }>;
type Images = readonly InputImage[] | undefined;

/** The image types every runtime with image input accepts. */
const mediaTypes: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const accepted = new Set(Object.values(mediaTypes));
const mediaTypeOf = (image: InputImage): string | undefined => image.mediaType ?? mediaTypes[extname(image.path).toLowerCase()];
const rejected = (code: Rejected["code"], reason: string): Rejected => ({ kind: "rejected", code, reason });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Why an input's images cannot go, or null when they can: a session without
 * image input refuses any image `unsupported`, and so does a file that is not
 * a png/jpeg/gif/webp; an unreadable one is an `error`. The whole input is
 * refused, so nothing is ever delivered without the images it came with. An
 * adapter asks after its own refusals (`busy` keeps its meaning).
 */
export function inputImagesRefusal(capabilities: Pick<SessionCapabilities, "images">, images: Images): Rejected | null {
  if (images === undefined || images.length === 0) {
    return null;
  }
  if (!capabilities.images) {
    return rejected("unsupported", "this runtime takes no image input");
  }
  for (const image of images) {
    const mediaType = mediaTypeOf(image);
    if (mediaType === undefined || !accepted.has(mediaType)) {
      return rejected("unsupported", `not a png, jpeg, gif or webp image: ${image.path}`);
    }
    try {
      accessSync(image.path, constants.R_OK);
    } catch (error) {
      return rejected("error", `cannot read image ${image.path}: ${message(error)}`);
    }
  }
  return null;
}

/** Deliver an input with its images read (see `inputImagesRefusal`), or refuse it. */
export function withInputImages<T extends ResponseBody | Promise<ResponseBody>>(
  capabilities: Pick<SessionCapabilities, "images">,
  images: Images,
  deliver: (loaded: readonly LoadedImage[]) => T,
): T | Rejected {
  const refused = inputImagesRefusal(capabilities, images);
  if (refused !== null) {
    return refused;
  }
  const loaded: LoadedImage[] = [];
  for (const image of images ?? []) {
    try {
      loaded.push({ path: image.path, mediaType: mediaTypeOf(image) ?? "", data: readFileSync(image.path).toString("base64") });
    } catch (error) {
      return rejected("error", `cannot read image ${image.path}: ${message(error)}`);
    }
  }
  return deliver(loaded);
}
