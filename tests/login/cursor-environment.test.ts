import { expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { cursorLoginWith } from "../../packages/oar/src/runtimes/cursor/login.js";
import { cursorLogoutWith } from "../../packages/oar/src/runtimes/cursor/logout.js";
import { cursorAuthStatusWith } from "../../packages/oar/src/runtimes/cursor/auth-status.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

test("Cursor refuses non-empty auth environments before loading its in-process SDK", async () => {
  const load = vi.fn(async (): Promise<never> => { throw new Error("must not load"); });
  const installation = { kind: "available", via: "bundled" } as const;
  await Promise.all([{ HOME: "elsewhere" }, { HOME: null }].map(async (env) => {
    await Promise.all([
      async () => cursorLoginWith(load)(installation, recordedInteraction([]), { env }),
      async () => cursorLogoutWith(load)(installation, { env }),
      async () => cursorAuthStatusWith(load)(installation, { env }),
    ].map(async (call) => {
      const result = call();
      await expect(result).rejects.toBeInstanceOf(UnsupportedOptionError);
      await expect(result).rejects.toMatchObject({ option: "env" });
    }));
  }));
  expect(load).not.toHaveBeenCalled();
});

test("an empty environment is a no-op, as for Cursor sessions", async () => {
  const load = vi.fn(async (): Promise<never> => { throw new Error("synthetic load failure"); });
  const installation = { kind: "available", via: "bundled" } as const;
  await cursorLoginWith(load)(installation, recordedInteraction([]), { env: {} });
  await cursorLogoutWith(load)(installation, { env: {} });
  await cursorAuthStatusWith(load)(installation, { env: {} });
  expect(load).toHaveBeenCalledTimes(3);
});
