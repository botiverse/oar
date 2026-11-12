/* oxlint-disable eslint/max-lines -- One terminal emulator: its state machine and the control sequences it handles stay together. */
/**
 * The text a terminal of a fixed size would show after a stream of output:
 * enough of a VT100/xterm screen to read Claude Code's terminal UI, which
 * repaints by moving the cursor and rewriting parts of lines. Colours and
 * styles are dropped; only where each character ends up is kept.
 */

type ParseState = "text" | "escape" | "csi" | "string" | "string_escape" | "charset";

/** Zero-width code points that attach to the cell before them. */
function isZeroWidth(codePoint: number): boolean {
  return (codePoint >= 0x03_00 && codePoint <= 0x03_6F)
    || (codePoint >= 0x20_0B && codePoint <= 0x20_0F)
    || (codePoint >= 0xFE_00 && codePoint <= 0xFE_0F)
    || codePoint === 0x20_60
    || codePoint === 0xFE_FF;
}

/** Code points a terminal draws two cells wide (CJK, emoji). */
function isWide(codePoint: number): boolean {
  return (codePoint >= 0x11_00 && codePoint <= 0x11_5F)
    || (codePoint >= 0x2E_80 && codePoint <= 0xA4_CF)
    || (codePoint >= 0xAC_00 && codePoint <= 0xD7_A3)
    || (codePoint >= 0xF9_00 && codePoint <= 0xFA_FF)
    || (codePoint >= 0xFE_30 && codePoint <= 0xFE_6F)
    || (codePoint >= 0xFF_00 && codePoint <= 0xFF_60)
    || (codePoint >= 0xFF_E0 && codePoint <= 0xFF_E6)
    || (codePoint >= 0x1_F3_00 && codePoint <= 0x1_FA_FF)
    || (codePoint >= 0x2_00_00 && codePoint <= 0x3_FF_FD);
}

export class TerminalScreen {
  private grid: string[][];
  private saved: { grid: string[][]; row: number; col: number } | null = null;
  private row = 0;
  private col = 0;
  private savedCursor = { row: 0, col: 0 };
  private wrapPending = false;
  private scrollTop = 0;
  private scrollBottom: number;
  private state: ParseState = "text";
  private csi = "";

  constructor(readonly cols: number, readonly rows: number) {
    this.grid = this.blankGrid();
    this.scrollBottom = rows - 1;
  }

  /** The screen's rows, each without trailing blanks, joined by newlines. */
  text(): string {
    return this.grid.map((cells) => cells.join("").replace(/[ \t]+$/u, "")).join("\n");
  }

  write(chunk: string): void {
    for (const char of chunk) { this.consume(char); }
  }

  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }

  private blankGrid(): string[][] {
    return Array.from({ length: this.rows }, () => this.blankRow());
  }

  private consume(char: string): void {
    switch (this.state) {
      case "text":
        this.consumeText(char);
        return;
      case "escape":
        this.consumeEscape(char);
        return;
      case "csi":
        if (char >= "@" && char <= "~") {
          this.state = "text";
          this.runCsi(this.csi, char);
        } else if (char === "\u001B") {
          this.state = "escape";
        } else {
          this.csi += char;
        }
        return;
      case "string":
        // OSC, DCS and the like: skipped up to BEL or ST.
        if (char === "\u0007") { this.state = "text"; }
        else if (char === "\u001B") { this.state = "string_escape"; }
        return;
      case "string_escape":
        this.state = char === "\\" ? "text" : "string";
        return;
      case "charset":
        this.state = "text";
        break;
    }
  }

  private consumeText(char: string): void {
    switch (char) {
      case "\u001B":
        this.state = "escape";
        return;
      case "\r":
        this.col = 0;
        this.wrapPending = false;
        return;
      case "\n":
      case "\u000B":
      case "\u000C":
        this.lineFeed();
        return;
      case "\b":
        if (this.col > 0) { this.col -= 1; }
        this.wrapPending = false;
        return;
      case "\t":
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        return;
    }
    // `char` is one code point of the output, never empty.
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7F) { return; }
    if (isZeroWidth(codePoint)) { return; }
    const width = isWide(codePoint) ? 2 : 1;
    if (this.wrapPending || this.col + width > this.cols) {
      this.col = 0;
      this.wrapPending = false;
      this.lineFeed();
    }
    const cells = this.cellsOf(this.row);
    cells[this.col] = char;
    if (width === 2) { cells[this.col + 1] = ""; }
    if (this.col + width >= this.cols) {
      this.col = this.cols - 1;
      this.wrapPending = true;
    } else {
      this.col += width;
    }
  }

  private consumeEscape(char: string): void {
    this.state = "text";
    switch (char) {
      case "[":
        this.csi = "";
        this.state = "csi";
        return;
      case "]":
      case "P":
      case "X":
      case "^":
      case "_":
        this.state = "string";
        return;
      case "(":
      case ")":
      case "*":
      case "+":
      case "#":
        this.state = "charset";
        return;
      case "7":
        this.savedCursor = { row: this.row, col: this.col };
        return;
      case "8":
        this.moveTo(this.savedCursor.row, this.savedCursor.col);
        return;
      case "D":
        this.lineFeed();
        return;
      case "E":
        this.col = 0;
        this.lineFeed();
        return;
      case "M":
        if (this.row === this.scrollTop) { this.scroll(-1); }
        else if (this.row > 0) { this.row -= 1; }
        return;
      case "c":
        this.grid = this.blankGrid();
        this.scrollTop = 0;
        this.scrollBottom = this.rows - 1;
        this.moveTo(0, 0);
        break;
    }
  }

  /** A row's cells; the grid always holds `rows` rows. */
  private cellsOf(row: number): string[] {
    const cells = this.grid[row];
    if (cells === undefined) { throw new RangeError(`Terminal screen: no row ${row}`); }
    return cells;
  }

  private moveTo(row: number, col: number): void {
    this.row = Math.max(0, Math.min(this.rows - 1, row));
    this.col = Math.max(0, Math.min(this.cols - 1, col));
    this.wrapPending = false;
  }

  private lineFeed(): void {
    this.wrapPending = false;
    if (this.row === this.scrollBottom) { this.scroll(1); }
    else if (this.row < this.rows - 1) { this.row += 1; }
  }

  /** Scrolls the scroll region up (positive) or down (negative) by whole lines. */
  private scroll(lines: number, top = this.scrollTop): void {
    for (let count = Math.abs(lines); count > 0; count -= 1) {
      if (lines > 0) {
        this.grid.splice(top, 1);
        this.grid.splice(this.scrollBottom, 0, this.blankRow());
      } else {
        this.grid.splice(this.scrollBottom, 1);
        this.grid.splice(top, 0, this.blankRow());
      }
    }
  }

  private eraseCells(row: number, from: number, to: number): void {
    const cells = this.cellsOf(row);
    for (let col = Math.max(0, from); col < Math.min(this.cols, to); col += 1) { cells[col] = " "; }
  }

  private runCsi(body: string, final: string): void {
    const isPrivate = /^[?<=>]/u.test(body);
    // oxlint-disable-next-line unicorn/prefer-number-coercion -- parseInt reads "5x" as 5 and "" as NaN (the default); Number would not.
    const numbers = body.replace(/^[?<=>]/u, "").split(/[;:]/u).map((part) => Number.parseInt(part, 10));
    const arg = (index: number, fallback: number): number => {
      const value = numbers[index];
      return value === undefined || Number.isNaN(value) || value === 0 ? fallback : value;
    };
    if (isPrivate) {
      // Only the alternate screen matters: it starts blank and gives the main screen back.
      if ((final === "h" || final === "l") && numbers.some((mode) => mode === 1049 || mode === 1047 || mode === 47)) {
        if (final === "h" && !this.saved) {
          this.saved = { grid: this.grid, row: this.row, col: this.col };
          this.grid = this.blankGrid();
          this.moveTo(0, 0);
        } else if (final === "l" && this.saved) {
          this.grid = this.saved.grid;
          this.moveTo(this.saved.row, this.saved.col);
          this.saved = null;
        }
      }
      return;
    }
    // A CSI with an intermediate byte (cursor style and such) moves nothing.
    if (/[ -/]/u.test(body)) { return; }
    switch (final) {
      case "A":
        this.moveTo(this.row - arg(0, 1), this.col);
        return;
      case "B":
      case "e":
        this.moveTo(this.row + arg(0, 1), this.col);
        return;
      case "C":
      case "a":
        this.moveTo(this.row, this.col + arg(0, 1));
        return;
      case "D":
        this.moveTo(this.row, this.col - arg(0, 1));
        return;
      case "E":
        this.moveTo(this.row + arg(0, 1), 0);
        return;
      case "F":
        this.moveTo(this.row - arg(0, 1), 0);
        return;
      case "G":
      case "`":
        this.moveTo(this.row, arg(0, 1) - 1);
        return;
      case "d":
        this.moveTo(arg(0, 1) - 1, this.col);
        return;
      case "H":
      case "f":
        this.moveTo(arg(0, 1) - 1, arg(1, 1) - 1);
        return;
      case "J": {
        const mode = arg(0, 0);
        if (mode === 0) {
          this.eraseCells(this.row, this.col, this.cols);
          for (let row = this.row + 1; row < this.rows; row += 1) { this.eraseCells(row, 0, this.cols); }
        } else if (mode === 1) {
          for (let row = 0; row < this.row; row += 1) { this.eraseCells(row, 0, this.cols); }
          this.eraseCells(this.row, 0, this.col + 1);
        } else if (mode === 2) {
          for (let row = 0; row < this.rows; row += 1) { this.eraseCells(row, 0, this.cols); }
        }
        this.wrapPending = false;
        return;
      }
      case "K": {
        const mode = arg(0, 0);
        if (mode === 0) { this.eraseCells(this.row, this.col, this.cols); }
        else if (mode === 1) { this.eraseCells(this.row, 0, this.col + 1); }
        else if (mode === 2) { this.eraseCells(this.row, 0, this.cols); }
        this.wrapPending = false;
        return;
      }
      case "X":
        this.eraseCells(this.row, this.col, this.col + arg(0, 1));
        return;
      case "P": {
        const cells = this.cellsOf(this.row);
        const count = Math.min(arg(0, 1), this.cols - this.col);
        cells.splice(this.col, count);
        while (cells.length < this.cols) { cells.push(" "); }
        return;
      }
      case "@": {
        const cells = this.cellsOf(this.row);
        const count = Math.min(arg(0, 1), this.cols - this.col);
        cells.splice(this.col, 0, ...Array.from({ length: count }, () => " "));
        cells.length = this.cols;
        return;
      }
      case "L":
        if (this.row >= this.scrollTop && this.row <= this.scrollBottom) { this.scroll(-arg(0, 1), this.row); }
        return;
      case "M":
        if (this.row >= this.scrollTop && this.row <= this.scrollBottom) { this.scroll(arg(0, 1), this.row); }
        return;
      case "S":
        this.scroll(arg(0, 1));
        return;
      case "T":
        this.scroll(-arg(0, 1));
        return;
      case "r": {
        const top = arg(0, 1) - 1;
        const bottom = arg(1, this.rows) - 1;
        if (top < bottom && bottom < this.rows) {
          this.scrollTop = top;
          this.scrollBottom = bottom;
        }
        this.moveTo(0, 0);
        return;
      }
      case "s":
        this.savedCursor = { row: this.row, col: this.col };
        return;
      case "u":
        this.moveTo(this.savedCursor.row, this.savedCursor.col);
        break;
    }
  }
}
