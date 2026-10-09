/* oxlint-disable import/prefer-default-export -- Shared named helper. */
/** Copy diagnostic data, including Error fields and cause chains, replacing known strings without mutating native inputs. */
export function redactText<T>(value: T, redact: (text: string) => string, contains: (text: string) => boolean): T {
  const scanned = new Set<object>();
  const matches = (entry: unknown): boolean => {
    if (typeof entry === "string") { return contains(entry); }
    if (entry === null || typeof entry !== "object" || scanned.has(entry)) { return false; }
    scanned.add(entry);
    if (Array.isArray(entry)) { return entry.some((item) => matches(item)); }
    return Object.getOwnPropertyNames(entry).some((key) => {
      if (contains(key)) { return true; }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (descriptor !== undefined && "value" in descriptor) { return matches(descriptor.value); }
      return entry instanceof Error && key === "stack" && matches(entry.stack);
    });
  };
  if (!matches(value)) { return value; }

  const seen = new Map<object, unknown>();
  const copy = (entry: unknown): unknown => {
    if (typeof entry === "string") { return redact(entry); }
    if (entry === null || typeof entry !== "object") { return entry; }
    if (seen.has(entry)) { return seen.get(entry); }
    if (Array.isArray(entry)) {
      const result: unknown[] = [];
      seen.set(entry, result);
      for (const item of entry) { result.push(copy(item)); }
      return result;
    }
    // Keep native Error classes (notably RuntimeFailureError) and non-enumerable
    // message/stack/cause, even for frozen SDK errors. Never unwrap spawn errors.
    // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-argument -- Object's reflection API is untyped; preserve the native Error brand and its class prototype.
    const result: object = entry instanceof Error ? Object.setPrototypeOf(new Error(redact(entry.message)), Object.getPrototypeOf(entry)) : {};
    seen.set(entry, result);
    for (const key of Object.getOwnPropertyNames(entry)) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (descriptor !== undefined && "value" in descriptor) {
        Object.defineProperty(result, redact(key), { ...descriptor, value: copy(descriptor.value) });
      } else if (entry instanceof Error && key === "stack" && typeof entry.stack === "string") {
        // Node 24 exposes the lazily computed stack as an accessor. Copy its
        // redacted text, never a getter closing over the original Error.
        Object.defineProperty(result, "stack", { value: redact(entry.stack), configurable: true, writable: true });
      }
    }
    return result;
  };
  // Text leaves keep their types; only strings change, never the structure's kinds.
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- The recursive copy preserves scalar types, descriptors and array/object structure.
  return copy(value) as T;
}
