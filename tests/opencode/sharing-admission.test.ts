import { expect, test } from "vitest";
import { opencodeCandidateRefusal } from "../../experiments/sharing/opencode-candidate.js";
import { opencodeSharedRefusal } from "../../packages/oar/src/runtimes/opencode/sharing-admission.js";

const installation = { kind: "available", via: "executable", command: "opencode" } as const;
for (const version of ["2.2.3", "2.2.5"]) {
  test.each([["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]] as const)(`OpenCode ${version} experiment retains the measured %s/%s cell`, (platform, arch) => {
    for (const reported of [version, `v${version}`, `opencode v${version}`]) {
      expect(opencodeCandidateRefusal({ ...installation, version: reported }, platform, arch)).toBeNull();
    }
  });
  test.each([["linux", "arm64"], ["darwin", "x64"], ["win32", "arm64"], ["freebsd", "x64"]] as const)(`OpenCode ${version}: unmeasured %s/%s never inherits sharing`, (platform, arch) => {
    expect(opencodeCandidateRefusal({ ...installation, version }, platform, arch)).not.toBeNull();
  });
}
test.each(["2.2.2", "2.2.4", "2.2.6", "2.2.30", "2.2.50", "2.2.3-dev", "2.2.3+local", "2.2.5-dev", "2.2.5+local", "1.19.5", undefined])("unmeasured version %s never inherits sharing", version => {
  expect(opencodeCandidateRefusal({ kind: "available", via: "executable", command: "opencode", ...(version === undefined ? {} : { version }) }, "linux", "x64")).not.toBeNull();
});

test("production refusal is unconditional, regardless of experimental evidence", () => {
  expect(opencodeSharedRefusal()).toContain("configured plugins");
});
