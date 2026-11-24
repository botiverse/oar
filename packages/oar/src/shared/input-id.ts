/**
 * The one shape a logical input id takes (docs/spec/conversation.md): a UUID.
 * Every prompt, steer and queue passes through `sealSession`'s check, and a
 * restored input is held to the same rule before anything is sent, so a host's
 * fresh id is either one the runtime accepts or it is refused here.
 */
const INPUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isInputId(value: string): boolean {
  return INPUT_ID.test(value);
}
