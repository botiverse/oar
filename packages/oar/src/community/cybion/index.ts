import type { RuntimeBrand } from "../../contracts/brand.js";
import type { InstallationProbe } from "../../contracts/installation.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { CybionClient, type CybionOptions } from "./client.js";
import { cybionRefusedSessionOptions } from "./refused-options.js";
import { cybionSessionWith } from "./session.js";

export type { CybionOptions } from "./client.js";

/**
 * The Cybion mark, `assets/brands/cybion.svg` (see `assets/brands/NOTICE.md`),
 * inline so a host shows it without a file read. It carries its own background,
 * so one asset serves both themes.
 */
const cybionBrand: RuntimeBrand = {
  name: "Cybion",
  icon: `data:image/svg+xml,${encodeURIComponent("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1024\" height=\"1024\" viewBox=\"0 0 1024 1024\">\n  <defs>\n    <linearGradient id=\"bg\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">\n      <stop offset=\"0\" stop-color=\"#54545e\"/>\n      <stop offset=\"0.45\" stop-color=\"#2a2a30\"/>\n      <stop offset=\"1\" stop-color=\"#161616\"/>\n    </linearGradient>\n    <linearGradient id=\"metal\" x1=\"0\" y1=\"0\" x2=\"0.15\" y2=\"1\">\n      <stop offset=\"0\" stop-color=\"#ffffff\"/>\n      <stop offset=\"0.5\" stop-color=\"#d2d2da\"/>\n      <stop offset=\"1\" stop-color=\"#92929c\"/>\n    </linearGradient>\n    <filter id=\"glow\" x=\"-40%\" y=\"-40%\" width=\"180%\" height=\"180%\">\n      <feGaussianBlur stdDeviation=\"20\"/>\n    </filter>\n  </defs>\n\n  <rect x=\"0\" y=\"0\" width=\"1024\" height=\"1024\" fill=\"url(#bg)\"/>\n\n  <!-- soft halo around the mark -->\n  <path d=\"M512 337 L714 687 L310 687 Z\" fill=\"none\" stroke=\"#ffffff\"\n        stroke-width=\"86\" stroke-linejoin=\"round\" opacity=\"0.5\" filter=\"url(#glow)\"/>\n\n  <!-- the mark -->\n  <path d=\"M512 337 L714 687 L310 687 Z\" fill=\"none\" stroke=\"url(#metal)\"\n        stroke-width=\"86\" stroke-linejoin=\"round\"/>\n</svg>\n")}`,
};

/** The adapter drives a deployment over HTTP: there is no local executable to probe. */
const cybionInstallation: InstallationProbe = async () => {
  await Promise.resolve();
  return { kind: "available", via: "bundled" };
};

/** A cybion runtime: its installation fact and refusals are always there. */
export type CybionRuntime = Runtime & Required<Pick<Runtime, "installation" | "refusedSessionOptions">>;

/**
 * Cybion, driven through its Agent API (`/v1/threads`; docs/runtimes/cybion.md).
 * A community runtime: not in the built-in `runtimes` registry; a host adds it
 * with `createRuntimeRegistry([...defaultRuntimes.list(), createCybionRuntime({
 * baseUrl, apiKey })])`. The deployment and its API key are the host's, so they
 * are constructor inputs: the adapter holds no credential of its own.
 */
export function createCybionRuntime(options: CybionOptions): CybionRuntime {
  const client = new CybionClient(options);
  return defineRuntime({
    id: "cybion",
    sessionCapabilities: () => ({ steer: true, images: true }),
    brand: cybionBrand,
    installation: cybionInstallation,
    session: cybionSessionWith(client),
    refusedSessionOptions: cybionRefusedSessionOptions,
  });
}
