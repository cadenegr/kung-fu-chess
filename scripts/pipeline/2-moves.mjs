// Step 2, moves: find the lines of the main games, the ones printed in two
// columns (move number + White's move on the left, Black's move on the right).
// Moves written inside the prose (side lines) are left for later.
//
// Run: node scripts/pipeline/2-moves.mjs <output folder>
// Reads 1-lines.jsonl. Writes:
//   2-moves.jsonl   one per move line: { page, y, num, white, black, clean, text }
//                   num, white and black are the raw OCR text (white or black
//                   can be null: "19... NxbS" has no White move, "34 Rb8!" no
//                   Black move). clean = every move looks like a move even
//                   with the usual look-alikes; false means heavier OCR damage
//                   ("l\\e8", "1Jd6", "NO"). Step 3 fixes the OCR mistakes.
//   2-rejects.jsonl lines that sit where moves sit (short, indented) but did
//                   not read as moves, to check by eye
//
// How a move line is recognised:
//   - it starts far right of the prose margin (x >= minX) and is short
//     (layout values come from the book's settings, see lib/settings.mjs)
//   - the left cell is a move number, maybe glued to the move ("3Bd3"),
//     maybe followed by "..." when Black's move comes alone ("19... NxbS")
//   - the right cell, if any, starts rightGap points to the right
//   - every move "looks like" a move once OCR look-alikes are allowed
//     (S for 5, l for 1, J for 3, ...): the real fixing happens in step 3
//   - a line in the same layout whose moves look damaged is still kept,
//     with clean: false, when its left cell starts with a move number

import { fail, readJsonl, writeJsonl } from "./lib/jsonl.mjs";
import { loadSettings } from "./lib/settings.mjs";

const dir = process.argv[2];
if (!dir) fail(2, "usage: node scripts/pipeline/2-moves.mjs <output folder>");
const lines = readJsonl(2, dir, "1-lines.jsonl");

const settings = loadSettings(2, dir);
const MIN_X = settings.layout.minX;          // prose starts further left
const MAX_LEN = settings.layout.maxLen;      // prose lines are longer
const RIGHT_GAP = settings.layout.rightGap;  // how far apart the two columns are

// OCR look-alikes, only for "does it look like a move": the output keeps the raw text.
const DIGIT = "0-9" + Object.keys(settings.lookalikes.number).join("").replace(/[\]\\^-]/g, "\\$&");
const FILE = "a-hr";               // r is a common misread of f
const RANK = "1-8lIitTSsJ";
const MOVE = new RegExp(
  "^(" +
    "[0O]-[0O](-[0O])?" +                                    // castling
    "|[KQRBN]?" + `[${FILE}]?[${RANK}]?` + "[x×]?" +       // piece, from-square hints, capture
    `[${FILE}][${RANK}]` + "(=?[QRBN])?" +                   // target square, promotion
  ")" +
  "(\\(?[QRBN]\\))?(ch|cb|\\+|#|mate|dbl\\.?ch)?[!?]*[,.;]?$",
);
const DOTS = /^(\.{2,}|[•·.]{2,}|…|"\.?|\.?")$/;              // "...", "•••", "17"." (OCR of 17...)
const NUM = new RegExp(`^[${DIGIT}]{1,3}`);

const looksLikeMove = (s) => MOVE.test(s.replace(/\s+/g, ""));

// Left cell: "9 Nf3", "3Bd3", "tONeS", "80-0", "19...", "25 ••• Qxb2", "S... cS".
function parseLeft(text) {
  const t = text.replace(/\s+/g, " ").trim();
  // Number + dots (+ maybe Black's move in the same cell)
  let m = t.match(new RegExp(`^([${DIGIT}]{1,3}) ?([.•·…"]{2,}|[.•·…]{1}\\s*[.•·…"]+|\\.?")\\s*(.*)$`));
  if (m) return { num: m[1], dots: true, move: m[3] || null };
  // Number glued to castling: "80-0" = 8 0-0
  m = t.match(new RegExp(`^([${DIGIT}]{1,3}?) ?([0O]-[0O](-[0O])?[!?]*)$`));
  if (m && m[1]) return { num: m[1], dots: false, move: m[2] };
  // Number + move, with or without a space. Try the longest number first
  // that leaves a move behind ("tONeS" → "tO" + "NeS").
  const n = t.match(NUM);
  if (!n) return null;
  for (let len = n[0].length; len >= 1; len--) {
    const move = t.slice(len).trim();
    if (move && looksLikeMove(move)) return { num: t.slice(0, len), dots: false, move };
  }
  return null;
}

// Fallback for damaged cells: a move number (1-2 characters, preferring a
// split where a piece or file letter follows) and whatever comes after it.
function parseLoose(text) {
  const t = text.replace(/\s+/g, " ").trim();
  const n = t.match(NUM);
  if (!n) return null;
  const lens = [2, 1].filter((len) => len <= n[0].length);
  const len = lens.find((l) => /^ ?[KQRBNa-h]/.test(t.slice(l))) ?? lens[0];
  const rest = t.slice(len).trim();
  // Headers like "INDEX", "SECTION (A)", "To restrain..." start with a letter
  // that looks like a digit: without a real digit, only a short move-like rest counts.
  if (!/\d/.test(t.slice(0, len)) && (rest.length > 6 || /^[A-Z]{3,}/.test(rest))) return null;
  const dots = rest.match(/^([.•·…"]+)\s*(.*)$/);
  if (dots) return { num: t.slice(0, len), dots: true, move: dots[2] || null };
  // "11~ Bd6", "5-. Nc6": specks where the dots were, so Black's move comes alone.
  if (rest && !/[A-Za-z0-9]/.test(rest)) return { num: t.slice(0, len), dots: true, move: null };
  return { num: t.slice(0, len), dots: false, move: rest || null };
}

const moves = [];
const rejects = [];
// OCR specks: "·", "~", "'" in front of or between cells. Dots ("•••") are kept.
const isSpeck = (t) => !/[A-Za-z0-9]/.test(t) && !/[.•…]{2,}/.test(t);
const tidy = (t) => t.replace(/0[·.]0/g, "0-0").replace(/(\.)~+(\.)/g, "$1$2").replace(/^[·'"~,:;]+/, "");

for (const raw of lines) {
  if (raw.items[0].x < MIN_X || raw.text.length > MAX_LEN) continue;
  const items = raw.items.filter((it) => !isSpeck(it.text)).map((it) => ({ ...it, text: tidy(it.text) }));
  if (items.length === 0) {
    rejects.push(raw);
    continue;
  }
  const line = { ...raw, items };
  const first = items[0];
  const left = line.items.filter((it) => it.x < first.x + RIGHT_GAP[0]);
  const right = line.items.filter((it) => it.x >= first.x + RIGHT_GAP[0] && it.x <= first.x + RIGHT_GAP[1] + 20);
  const leftText = left.map((it) => it.text).join(" ").replace(/([.•…])\s+(?=[.•…])/g, "$1");
  const rightText = right.map((it) => it.text).join(" ") || null;
  const parsed = left.length + right.length === line.items.length ? parseLeft(leftText) : null;

  let row = null;
  if (parsed) {
    if (parsed.dots && !parsed.move && rightText && looksLikeMove(rightText))
      row = { num: parsed.num, white: null, black: rightText };          // "19... | NxbS"
    else if (parsed.dots && parsed.move && !rightText && looksLikeMove(parsed.move))
      row = { num: parsed.num, white: null, black: parsed.move };        // "25 ••• Qxb2" in one cell
    else if (!parsed.dots && (!rightText || looksLikeMove(rightText)))
      row = { num: parsed.num, white: parsed.move, black: rightText };   // "9 Nf3 | h6", "34 Rb8!"
  }
  if (row) row.clean = true;
  // Damaged: same layout, starts with a number, but a move did not look like one.
  if (!row && left.length + right.length === line.items.length && (rightText || left.length)) {
    const loose = parseLoose(leftText);
    if (loose && (loose.move || rightText) && !(loose.dots && loose.move && rightText))
      row = loose.dots
        ? { num: loose.num, white: null, black: loose.move ?? rightText, clean: false }
        : { num: loose.num, white: loose.move, black: rightText, clean: false };
  }
  if (row) moves.push({ page: raw.page, y: raw.y, ...row, text: raw.text });
  else rejects.push({ page: raw.page, y: raw.y, text: raw.text, items: raw.items });
}

writeJsonl(dir, "2-moves.jsonl", moves);
writeJsonl(dir, "2-rejects.jsonl", rejects);
const halfMoves = moves.reduce((n, m) => n + (m.white ? 1 : 0) + (m.black ? 1 : 0), 0);
const pages = new Set(moves.map((m) => m.page)).size;
const damaged = moves.filter((m) => !m.clean).length;
console.log(`step 2: ${moves.length} move lines (${halfMoves} moves, ${damaged} lines damaged) on ${pages} pages, ` +
  `${rejects.length} short indented lines not read as moves → ${dir}/2-moves.jsonl, 2-rejects.jsonl`);
