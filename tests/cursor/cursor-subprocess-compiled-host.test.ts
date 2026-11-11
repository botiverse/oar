import { afterEach, expect, test, vi } from "vitest";
import { spawnNodeScript } from "../../packages/oar/src/shared/executable/node-script.js";

afterEach(() => { vi.restoreAllMocks(); });

test("a compiled single executable host starts no Node script child: its executable would start the application again", () => {
  const builtin = process.getBuiltinModule.bind(process);
  vi.spyOn(process, "getBuiltinModule").mockImplementation((id: string) => (id === "node:sea" ? { isSea: () => true } : builtin(id)));
  expect(() => spawnNodeScript("process.exit(0)", "[]", {})).toThrow(/compiled single executable/u);
});
