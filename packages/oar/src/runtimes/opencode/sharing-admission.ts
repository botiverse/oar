/** Exact versions retained by the disabled adapter's native initialize guard. */
export function isOpenCodeSharedVersion(version: unknown): boolean {
  return version === "2.2.3" || version === "2.2.5";
}

/** Configured plugins are not observable from SessionOptions, so no subset can be admitted. */
export function opencodeSharedRefusal(): string {
  return "OpenCode sharing is not admitted: configured plugins spawn children in the shared process HOME instead of the session cwd; use isolated placement";
}
