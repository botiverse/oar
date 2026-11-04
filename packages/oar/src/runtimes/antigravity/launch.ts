/** Keep the existing server launch contract for pinned legacy executables. */
export function isAntigravityCli(command: string): boolean {
  return /(?:^|[/\\])agy(?:\.exe|\.cmd)?$/iu.test(command);
}

export function antigravityAcpArgs(command: string, platform: NodeJS.Platform = process.platform): readonly string[] {
  if (isAntigravityCli(command)) {
    return ["acp"];
  }
  // The registry's Linux server drops privileges unless --uid= is empty.
  return platform === "linux" ? ["--uid="] : [];
}
