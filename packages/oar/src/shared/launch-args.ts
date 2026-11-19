import { UnsupportedOptionError } from "../contracts/errors.js";

/** Normalize a CLI token so `--flag=value`, `-pfoo`, and optional camelCase aliases match their canonical flag. */
export function normalizeLaunchFlag(arg: string, camelCase = false): string {
  const name = arg.split("=", 1)[0] ?? arg;
  if (name.startsWith("--")) {
    return camelCase ? name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`) : name;
  }
  return name.startsWith("-") && name !== "--" ? name.slice(0, 2) : name;
}

/** Refuse any `launchArgs` entry that collides with a protocol, identity, model, or prompt flag OAR owns. */
export function checkManagedLaunchArgs(
  args: readonly string[] | undefined,
  managed: ReadonlySet<string> | ReadonlyMap<string, string>,
  message: (flag: string, reason?: string) => string,
  options: { readonly camelCase?: boolean } = {},
): void {
  for (const arg of args ?? []) {
    const flag = normalizeLaunchFlag(arg, options.camelCase === true);
    if ("get" in managed) {
      const reason = managed.get(flag);
      if (reason !== undefined) { throw new UnsupportedOptionError("launchArgs", message(flag, reason)); }
    } else if (managed.has(flag)) {
      throw new UnsupportedOptionError("launchArgs", message(flag));
    }
  }
}
