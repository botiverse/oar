import { afterEach, expect, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); });
export function readerEnvironment(): { OAR_READER_CHANGED: string; OAR_READER_REMOVED: null } {
  vi.stubEnv("OAR_READER_CHANGED", "host");
  vi.stubEnv("OAR_READER_REMOVED", "host");
  return { OAR_READER_CHANGED: "child", OAR_READER_REMOVED: null };
}
export function expectReaderEnvironment(env: NodeJS.ProcessEnv | undefined): void {
  expect(env?.OAR_READER_CHANGED).toBe("child");
  expect(env?.OAR_READER_REMOVED).toBeUndefined();
  expect(process.env.OAR_READER_CHANGED).toBe("host");
  expect(process.env.OAR_READER_REMOVED).toBe("host");
}
