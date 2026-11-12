import assert from "node:assert/strict";
import { test } from "vitest";

import { TerminalScreen } from "../../packages/oar/src/runtimes/claude/limit-reset/terminal-screen.js";

const ESC = "\u001B";
const ESCM = `${ESC}M`;

function shown(output: string, cols = 20, rows = 4): string[] {
  const screen = new TerminalScreen(cols, rows);
  screen.write(output);
  return screen.text().split("\n");
}

test("plain lines land where a terminal puts them, styles dropped", () => {
  assert.deepEqual(shown(`${ESC}[1m${ESC}[38;5;12mUse${ESC}[0m a reset?\r\n  Yes`), ["Use a reset?", "  Yes", "", ""]);
});

test("a repaint moves the cursor and rewrites part of a line", () => {
  const output = `one\r\ntwo\r\nthree${ESC}[2A\r${ESC}[2KONE${ESC}[3;3HR${ESC}[K`;
  assert.deepEqual(shown(output), ["ONE", "two", "thR", ""]);
});

test("erase to the end of the screen, and a full clear", () => {
  assert.deepEqual(shown(`aaa\r\nbbb\r\nccc${ESC}[2;2H${ESC}[J`), ["aaa", "b", "", ""]);
  assert.deepEqual(shown(`aaa\r\nbbb${ESC}[2J${ESC}[Hz`), ["z", "", "", ""]);
});

test("a full line wraps only when the next character comes, and the last row scrolls", () => {
  assert.deepEqual(shown("abcde\r\nx", 5, 3), ["abcde", "x", ""]);
  assert.deepEqual(shown("abcdef", 5, 3), ["abcde", "f", ""]);
  assert.deepEqual(shown("1\r\n2\r\n3\r\n4", 5, 3), ["2", "3", "4"]);
});

test("title and mode sequences draw nothing, even split across chunks", () => {
  const screen = new TerminalScreen(20, 2);
  for (const chunk of [`${ESC}]0;claude`, `\u0007${ESC}[?25`, `l${ESC}[?2026h❯\u00A0hi`, `${ESC}[?2026l${ESC}`, "[1Gok"]) { screen.write(chunk); }
  assert.deepEqual(screen.text().split("\n"), ["okhi", ""]);
});

test("the alternate screen starts blank and gives the main screen back", () => {
  assert.deepEqual(shown(`main${ESC}[?1049h${ESC}[Halt`, 10, 2), ["alt", ""]);
  assert.deepEqual(shown(`main${ESC}[?1049h${ESC}[Halt${ESC}[?1049l`, 10, 2), ["main", ""]);
});

test("a wide character takes two cells", () => {
  assert.deepEqual(shown(`${ESC}[1;1H你好${ESC}[1;3H!`, 10, 1), ["你!"]);
});

test("a screen of Claude Code's size scrolls: the 46th line pushes the first off the top", () => {
  const screen = new TerminalScreen(120, 45);
  screen.write(Array.from({ length: 46 }, (_, index) => `line ${index + 1}`).join("\r\n"));
  const lines = screen.text().split("\n");
  assert.equal(lines.length, 45);
  assert.equal(lines[0], "line 2");
  assert.equal(lines[44], "line 46");
  screen.write("\r\n\r\n❯ /limit-reset weekly");
  assert.deepEqual(screen.text().split("\n").slice(-3), ["line 46", "", "❯ /limit-reset weekly"]);
});

test("a scroll region scrolls only its own rows", () => {
  // Rows 2-4 scroll; row 1 and row 5 stay.
  const output = `top\r\na\r\nb\r\nc\r\nbottom${ESC}[2;4r${ESC}[4;1H\nd\n\re`;
  assert.deepEqual(shown(output, 10, 5), ["top", "c", "d", "e", "bottom"]);
  // Reverse index at the top of the region scrolls it down.
  assert.deepEqual(shown(`top\r\na\r\nb\r\nc\r\nbottom${ESC}[2;4r${ESC}[2;1H${ESCM}z`, 10, 5), ["top", "z", "a", "b", "bottom"]);
  // Resetting the region makes the whole screen scroll again.
  assert.deepEqual(shown(`1\r\n2\r\n3${ESC}[1;2r${ESC}[r${ESC}[3;1H\n4`, 10, 3), ["2", "3", "4"]);
});

test("insert and delete line move the rows below, inside the scroll region", () => {
  assert.deepEqual(shown(`a\r\nb\r\nc\r\nd${ESC}[2;1H${ESC}[Lnew`, 10, 4), ["a", "new", "b", "c"]);
  assert.deepEqual(shown(`a\r\nb\r\nc\r\nd${ESC}[2;1H${ESC}[2M`, 10, 4), ["a", "d", "", ""]);
  assert.deepEqual(shown(`a\r\nb\r\nc\r\nd${ESC}[1;3r${ESC}[1;1H${ESC}[M`, 10, 4), ["b", "c", "", "d"]);
});

test("insert, delete and erase characters shift only their own line", () => {
  assert.deepEqual(shown(`abcdef${ESC}[1;3H${ESC}[2P`, 10, 1), ["abef"]);
  assert.deepEqual(shown(`abcdef${ESC}[1;3H${ESC}[2@`, 10, 1), ["ab  cdef"]);
  assert.deepEqual(shown(`abcdef${ESC}[1;3H${ESC}[2X`, 10, 1), ["ab  ef"]);
});
