// Book settings: everything that depends on how one particular book is printed.
// The scripts hold no book-specific values; a book's file in books/<name>.json
// overrides the defaults below (only the keys it names).
//
// Step 1 copies the book's settings into the output folder as 0-settings.json,
// so every later step (and a later look at the results) uses the same values.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./jsonl.mjs";

export const DEFAULTS = {
  // Step 2: where the two-column move lines sit on the page (PDF points).
  layout: {
    minX: 110,            // a move line starts right of this (prose starts further left)
    maxLen: 28,           // a move line has at most this many characters
    rightGap: [75, 120],  // Black's column starts this far right of White's
  },
  // Step 3: header lines between games (regular expressions, case-insensitive
  // where marked with "i" in flags). Matched against short indented lines.
  headers: {
    page: { source: "^$", flags: "" },     // running page headers to ignore
    line: { source: "^(CHAPTER|SECTION|VARIATION)\\b", flags: "i" }, // theory headings
    game: { source: "\\b1[89]\\d\\d\\b|^\\S+-\\S+$", flags: "" },     // year, or NAME-NAME
    result: { source: "resigns|^(mate )?(1-0|0-1|½-½|draw)", flags: "i" },
  },
  // Steps 3-4: OCR look-alikes. Key = what the scan printed, value = what it may be.
  // number: used to read move numbers.
  // move:   used to match a printed move against the legal moves (one printed
  //         piece of text may stand for one character); costs 1 each.
  // rare:   look-alikes that happen but seldom; cost 2 each, so they only win
  //         when the common reading makes the game illegal later.
  lookalikes: {
    number: { l: "1", I: "1", i: "1", t: "1", T: "1", S: "5", s: "5", O: "0", o: "0", J: "3", Z: "2", z: "2" },
    move: {
      l: "1f", I: "1", i: "1f", t: "1f", T: "1", "!": "1", j: "3", J: "3B", S: "58", s: "58", C: "c",
      Z: "2", z: "2", O: "0Q", o: "0", G: "6", b: "6h", h: "b", B: "8", "8": "B",
      r: "f", "£": "f", "1": "f", e: "c", c: "e", q: "g", "9": "g", D: "B",
      "1J": "B", IJ: "B", JJ: "B", lJ: "B", "l\\": "R", "l~": "R", "ll": "R",
    },
    rare: { l: "2", i: "2", C: "f", c: "f", e: "f", S: "3", s: "3", b: "5", h: "6" },
  },
};

export function loadSettings(step, dir) {
  const file = join(dir, "0-settings.json");
  if (!existsSync(file)) fail(step, `needs ${file}: run step 1 first`);
  return JSON.parse(readFileSync(file, "utf8"));
}

// Defaults with a book's overrides on top (one level deep per section).
export function mergeSettings(book) {
  const out = structuredClone(DEFAULTS);
  for (const [section, values] of Object.entries(book ?? {})) {
    if (section.startsWith("_")) continue; // "_about" and other notes
    if (!(section in out)) throw new Error(`unknown settings section "${section}"`);
    out[section] = { ...out[section], ...values };
  }
  return out;
}

export const regex = ({ source, flags }) => new RegExp(source, flags);
