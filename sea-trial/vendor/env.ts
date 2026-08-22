/** Run a body with process.env overlaid (readers read process.env, not SessionOptions.env), restoring the previous values afterwards. */
export async function withProcessEnv(
  overlay: Readonly<Record<string, string>>,
  body: () => Promise<void>,
): Promise<void> {
  const previous = new Map(Object.keys(overlay).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overlay);
  try {
    await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
