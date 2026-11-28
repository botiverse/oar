import type { RuntimeCredentials } from "../../contracts/credentials.js";
import { piCredentials } from "../pi/credential-shape.js";

/**
 * bottega reaches models through pi-ai, as pi does, so it reads the same
 * provider variables (`env-api-keys`); a variable the process already has
 * wins over bottega's key file, which `bottega serve` loads at start
 * (`framework/host/store.ts`, `loadKeys`). A custom endpoint in bottega's
 * settings reads `BOTTEGA_KEY_<ID>`. bottega also uses the ChatGPT login
 * Codex keeps. It has no login of its own for a host to drive.
 */
export const bottegaCredentials: RuntimeCredentials = {
  scope: "per_provider",
  management: "external",
  env: piCredentials.env ?? [],
  stores: [
    { kind: "file", directoryEnv: "BOTTEGA_HOME", defaultDirectory: ".bottega", path: ".env", overridesEnv: false },
    { kind: "file", directoryEnv: "BOTTEGA_HOME", defaultDirectory: ".bottega", path: "settings.json", overridesEnv: false },
    { kind: "file", directoryEnv: "CODEX_HOME", defaultDirectory: ".codex", path: "auth.json", overridesEnv: false },
  ],
};
