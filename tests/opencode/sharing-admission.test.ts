import { expect, test } from "vitest";
import { opencodeSharedRefusal } from "../../packages/oar/src/runtimes/opencode/sharing-admission.js";

const installation = { kind: "available", via: "executable", command: "opencode", version: "opencode v2.2.3" } as const;
test.each([["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]] as const)("OpenCode sharing admits the measured %s/%s cell", (platform, arch) => {
  expect(opencodeSharedRefusal(installation, platform, arch)).toBeNull();
});
test.each(["2.2.2", "2.2.4", "2.2.30", "2.2.3-dev", "2.2.3+local", "1.19.5", undefined])("unmeasured version %s never inherits sharing", version => {
  expect(opencodeSharedRefusal({ kind: "available", via: "executable", command: "opencode", ...(version === undefined ? {} : { version }) }, "linux", "x64")).not.toBeNull();
});
test.each([["linux", "arm64"], ["darwin", "x64"], ["win32", "arm64"], ["freebsd", "x64"]] as const)("unmeasured %s/%s never inherits sharing", (platform, arch) => {
  expect(opencodeSharedRefusal(installation, platform, arch)).not.toBeNull();
});
