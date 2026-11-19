import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/index.js";
import { compareSemver } from "../../packages/oar/src/shared/semver.js";
import { dshEnabled, nativeShell, posix, say, withDshFixture } from "./support/dsh-fixture.js";
import { lastInput } from "./support/dsh-provider.js";

test.skipIf(!dshEnabled)("DSH extra directories follow the session's version, sandbox mode and resume options", async () => {
  await mkdir("oar-trial-run", { recursive: true });
  const extra = await mkdtemp(path.resolve("oar-trial-run/dsh-grant-"));
  const target = path.join(extra, "proof");
  let marker = "first";
  const issued = new Set<string>();
  try {
    await withDshFixture(request => {
      if (!lastInput(request).includes("WRITE_ROOT") || issued.has(marker)) { return say("finished"); }
      issued.add(marker);
      return { kind: "tool", name: nativeShell.tool, arguments: { description: "extra-root control", command: `printf ${marker} > '${target.replaceAll("'", String.raw`'\''`)}'` } };
    }, async ({ installation, open }) => {
      assert.ok(installation.via === "executable" && installation.version !== undefined);
      const granted = { additionalDirectories: [extra] };
      if (!posix || (compareSemver(installation.version, "0.2.2-rc.3") ?? -1) < 0) {
        await expect(open(granted)).rejects.toMatchObject({ option: "additionalDirectories" });
        return;
      }
      const first = await open(granted);
      const submitted = await first.prompt("WRITE_ROOT");
      await awaitTurnEnd(first, submitted.seq);
      expect(await readFile(target, "utf8")).toBe(marker);
      await first.dispose();
      marker = "second";
      const resumed = await open({ ...granted, resume: first.id });
      const next = await resumed.prompt("WRITE_ROOT again");
      await awaitTurnEnd(resumed, next.seq);
      expect(await readFile(target, "utf8")).toBe(marker);
    }, { homePatch: [{ id: "sandbox-policy", config: { mode: "workspace-write" } }] });
  } finally { await rm(extra, { recursive: true, force: true }); }
}, 60_000);
