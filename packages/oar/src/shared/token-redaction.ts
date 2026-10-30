/* oxlint-disable import/prefer-default-export -- Shared credential-shape filter. */
const TOKEN_SHAPES = [
  /\bsk-[\w-]{16,}/gu, // Anthropic and OpenAI keys and OAuth tokens
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, // JWTs
];

/** Recognizable token shapes, including tokens absent from the host's explicit credentials. */
export function redactTokenShapes(text: string): string {
  return TOKEN_SHAPES.reduce((redacted, shape) => redacted.replace(shape, "[redacted]"), text);
}
