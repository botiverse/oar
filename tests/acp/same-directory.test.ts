import { expect, test } from "vitest";
import { sameDirectory } from "../../packages/oar/src/shared/acp/resume-cwd.js";

test.each(([
  ["/D:/a/oar/oar", String.raw`D:\a\oar\oar`, "win32", true],
  ["/C:/Users/test/AppData/Local/Temp/session", "C:/Users/test/AppData/Local/Temp/session", "win32", true],
  ["/D:/a/oar/oar", "C:/a/oar/oar", "win32", false],
  ["/D:/a/oar/oar", "D:/a/oar/other", "win32", false],
  ["/D:/a/oar/oar", "D:/a/oar/oar", "linux", false],
  ["/D:relative", "D:/relative", "win32", false],
  [String.raw`\\server\share\session`, "//server/share/session", "win32", true],
  ["/D:/a/space%20name", "D:/a/space name", "win32", false],
] as const).map(([saved, requested, platform, equal]) => ({ saved, requested, platform, equal })))("saved directory $saved and resume $requested on $platform agree: $equal", ({ saved, requested, platform, equal }) => {
  expect(sameDirectory(saved, requested, platform)).toBe(equal);
});
