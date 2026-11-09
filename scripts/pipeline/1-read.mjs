// Step 1, read: a chess book PDF → every text line with its page and position.
// The book is scanned pages with a hidden OCR text layer, so the text has
// OCR mistakes (S for 5, l for 1, ...). This step keeps the text as it is;
// later steps fix it. Positions are kept because a game is printed in two
// columns (White's move, Black's move) and a later step needs to tell them apart.
//
// Run: node scripts/pipeline/1-read.mjs <book.pdf> <output folder> [settings.json]
// The settings file holds how this book is printed (see lib/settings.mjs);
// without one the defaults are used.
// Writes 0-settings.json (defaults + the book's settings, used by later steps)
// and 1-lines.jsonl, one line of the page per JSON line:
//   { page, y, text, items: [{ x, text }] }
// page counts from 1; y is from the top of the page, x from the left (PDF points).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, writeJsonl } from "./lib/jsonl.mjs";
import { mergeSettings } from "./lib/settings.mjs";

const [file, dir, settingsFile] = process.argv.slice(2);
if (!file || !dir) fail(1, "usage: node scripts/pipeline/1-read.mjs <book.pdf> <output folder> [settings.json]");
if (!existsSync(file)) fail(1, `no such file: ${file}`);
if (settingsFile && !existsSync(settingsFile)) fail(1, `no such settings file: ${settingsFile}`);
let settings;
try {
  settings = mergeSettings(settingsFile ? JSON.parse(readFileSync(settingsFile, "utf8")) : {});
} catch (e) {
  fail(1, `${settingsFile}: ${e.message}`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;

// Two pieces of text belong to the same line if their y differs by less than this.
const SAME_LINE = 4;

const out = [];
let empty = 0;
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const height = page.getViewport({ scale: 1 }).height;
  const items = (await page.getTextContent()).items
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({ x: round(it.transform[4]), y: round(height - it.transform[5]), text: it.str.trim() }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (items.length === 0) empty++;

  const lines = [];
  for (const it of items) {
    const line = lines.at(-1);
    if (line && Math.abs(it.y - line.y) < SAME_LINE) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    out.push({
      page: p,
      y: line.y,
      text: line.items.map((it) => it.text).join(" "),
      items: line.items.map(({ x, text }) => ({ x, text })),
    });
  }
}

if (out.length === 0) fail(1, "no text found: this PDF has no text layer (it would need OCR first)");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "0-settings.json"), JSON.stringify(settings, null, 2) + "\n");
writeJsonl(dir, "1-lines.jsonl", out);
console.log(`step 1: settings ${settingsFile ?? "(defaults)"}; ${doc.numPages} pages, ${out.length} lines, ${empty} pages without text → ${dir}/1-lines.jsonl`);

function round(x) {
  return Math.round(x * 10) / 10;
}
