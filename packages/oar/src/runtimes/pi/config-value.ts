/** Pi resolves `$NAME` and leading `!` commands; these native escapes keep a supplied value literal. */
export function piLiteralConfigValue(value: string): string {
  return value.replaceAll("$", () => "$$").replace(/^!/u, "$!");
}
