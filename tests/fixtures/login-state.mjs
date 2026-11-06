/* oxlint-disable typescript/no-unsafe-call -- Standalone untyped fixture helper. */
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/** Preserve the last complete snapshot when a login test kills the writer. */
export default function saveLoginState(file, state) {
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, JSON.stringify(state), { flag: "wx" });
    renameSync(pending, file);
  } finally {
    rmSync(pending, { force: true });
  }
}
