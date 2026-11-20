import { zstdCompressSync } from "node:zlib";
import { expect, test } from "vitest";
import { decompressZstd, isDshSyntheticContextMessage, lastInput, zstdFrames } from "../../sea-trial/vendor/support/dsh-provider.js";
import { requestsForTurn } from "../../sea-trial/vendor/support/resumed-prompts.js";

/*
 * The fixture a native assertion depends on is itself pinned: a misread here
 * looked like a Windows runtime failure, and a misread log would look like
 * persistence loss.
 */
test("every Zstandard frame of a log is read, whatever the one-shot decoder does", () => {
  const parts = ['{"header":true}\n', '{"type":"a","seq":0}\n', '{"type":"b","seq":1}\n'];
  const log = Buffer.concat(parts.map((part) => zstdCompressSync(Buffer.from(part))));
  expect(zstdFrames(log)).toHaveLength(3);
  expect(decompressZstd(log)).toBe(parts.join(""));
});

test("a skippable frame carries no content, and a large frame with several blocks stays whole", () => {
  const skippable = Buffer.alloc(12);
  skippable.writeUInt32LE(0x18_4D_2A_50, 0);
  skippable.writeUInt32LE(4, 4);
  const large = Array.from({ length: 300_000 }, (_, index) => String(index % 251)).join(",");
  const log = Buffer.concat([zstdCompressSync(Buffer.from("first\n")), skippable, zstdCompressSync(Buffer.from(large))]);
  expect(zstdFrames(log)).toHaveLength(2);
  expect(decompressZstd(log)).toBe(`first\n${large}`);
});

test("a log that is not whole frames is an error, not a shorter log", () => {
  const whole = zstdCompressSync(Buffer.from("first\n"));
  expect(() => zstdFrames(Buffer.concat([whole, Buffer.from("not a frame")]))).toThrow(/not a Zstandard frame/u);
  expect(() => zstdFrames(whole.subarray(0, -2))).toThrow();
});

const user = (text: string): Record<string, unknown> => ({ role: "user", content: text });

test("the input is found past DSH's own context, including the Windows skill catalog", () => {
  const messages = [
    { role: "system", content: "s" },
    user("HOLD this"),
    user("Current runtime context. This snapshot supersedes earlier runtime-context snapshots."),
    user("<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>"),
  ];
  expect(lastInput({ body: {}, messages })).toBe(JSON.stringify("HOLD this"));
  expect(requestsForTurn([{ path: "/v1/chat/completions", body: { messages } }], "HOLD this")).toHaveLength(1);
});

test("DSH synthetic-context predicate skips standalone reminders without matching combined Qoder or user prompts", () => {
  const qoder = "<system-reminder>\nctx\n</system-reminder>\n\nCheck these instructions";
  const sandwich = "<system-reminder>a</system-reminder>\nCheck these instructions\n<system-reminder>b</system-reminder>";
  expect(isDshSyntheticContextMessage("<system-reminder>\nonly\n</system-reminder>")).toBe(true);
  expect(isDshSyntheticContextMessage(qoder)).toBe(false);
  expect(isDshSyntheticContextMessage(sandwich)).toBe(false);
  expect(requestsForTurn([{ path: "/v1/chat/completions", body: { messages: [{ role: "system", content: "s" }, user(qoder)] } }], "Check these instructions")).toHaveLength(1);
  expect(lastInput({ body: {}, messages: [user(qoder)] })).toBe(JSON.stringify(qoder));
  const unmatched: string[] = [];
  expect(requestsForTurn([{ path: "/v1/chat/completions", body: { messages: [user("Other"), user("<system-reminder>\nonly\n</system-reminder>")] } }], "Check these instructions", unmatched)).toEqual([]);
  expect(unmatched).toEqual(["Other"]);
});

test("after a tool result the input is still the latest user message; a later one replaces it", () => {
  const first = [user("WHERE are you"), { role: "assistant", content: "" }, { role: "tool", content: "/somewhere" }];
  expect(lastInput({ body: {}, messages: first })).toBe(JSON.stringify("WHERE are you"));
  expect(lastInput({ body: {}, messages: [...first, user("FAILED_TURN"), user("NEXT")] })).toBe(JSON.stringify("NEXT"));
  expect(lastInput({ body: {}, messages: [] })).toBe('""');
});
