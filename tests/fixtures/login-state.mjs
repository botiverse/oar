/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-member-access -- Standalone untyped fixture helper. */
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

const pause = new Int32Array(new SharedArrayBuffer(4));

function publishState(pending, file) {
  for (let retries = 0; ; retries++) {
    try { renameSync(pending, file); return; }
    catch (error) {
      if (process.platform !== "win32" || retries >= 10
        || !(error instanceof Error) || !("code" in error) || error.code !== "EPERM") { throw error; }
      // A Windows reader can temporarily prevent replacement. Keep the old
      // snapshot intact; add at most 250 ms of waits before surfacing failure.
      Atomics.wait(pause, 0, 0, 25);
    }
  }
}

/** Preserve the last complete snapshot when a login test kills the writer. */
export default function saveLoginState(file, state) {
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, JSON.stringify(state), { flag: "wx" });
    publishState(pending, file);
  } finally {
    rmSync(pending, { force: true });
  }
}
