import type { RuntimeBrand } from "../../contracts/brand.js";
import type { InstallationProbe } from "../../contracts/installation.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { CybionClient, type CybionOptions } from "./client.js";
import { cybionRefusedSessionOptions } from "./refused-options.js";
import { cybionSessionWith } from "./session.js";

export type { CybionOptions } from "./client.js";

/** Cybion ships no mark in this repository, so the brand carries its name and no icon. */
const cybionBrand: RuntimeBrand = { name: "Cybion", icon: null };

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
