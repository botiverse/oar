/** Only the experiment has evidence for this exact native protocol version. */
export function isGrokSharedVersion(version: unknown): boolean { return version === "1.0.70"; }

/** Native user/plugin MCP configuration cannot be ruled out from session options. */
export function grokSharedRefusal(): string {
  return "Grok sharing is not admitted: configured stdio MCP servers start in the shared process HOME instead of the session cwd; use isolated placement";
}
