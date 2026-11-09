// Step 3, games: group the move lines of step 2 into games, in reading order.
//
// Run: node scripts/pipeline/3-games.mjs <output folder>
// Reads 2-moves.jsonl, 2-rejects.jsonl (headers and results live there).
// Writes 3-games.jsonl, one per game or line:
//   { id, kind, title, page, start, result, from?, moves, gaps, dropped }
//   kind     "game"      has a header (players and/or place + year)
//            "line"      opening theory in the chapters (CHAPTER, SECTION, VARIATION ...)
//            "fragment"  column moves with no header, e.g. a side game quoted
//                        in the notes that starts in the middle ("8... NxeS")
//   title    the header lines above it, raw OCR text
//   start    the first move number (1 for a complete game)
//   from     id of the group whose moves were put in front: a game whose
//            header comes in the middle of a theory line that leads straight into it
//   moves    [{ n, side: "w"|"b", raw, page }] in order; raw is still OCR text
//   gaps     [{ after, missing, page }] where the numbering skips (lost lines)
//   dropped  rows that did not fit the numbering (diagram noise), raw
//
// Move numbers are OCR text too ("tO" = 10, "S" = 5): they are read with the
// look-alike table below and checked against the number expected next.
//   - A number longer than expected that starts with it ("208el" = 20 + "8el",
//     8 being a misread B): the extra characters belong to the move.
//   - A number that does not fit: if the NEXT row carries on from it, it is real
//     (a gap, or a new fragment when it goes backwards); otherwise it is a
//     damaged number (kept at the expected place when the row has the expected
//     shape) or noise from a diagram (dropped).

import { fail, readJsonl, writeJsonl } from "./lib/jsonl.mjs";
import { loadSettings, regex } from "./lib/settings.mjs";

const dir = process.argv[2];
if (!dir) fail(3, "usage: node scripts/pipeline/3-games.mjs <output folder>");
const rows = readJsonl(3, dir, "2-moves.jsonl");
const rejects = readJsonl(3, dir, "2-rejects.jsonl");

const settings = loadSettings(3, dir);
const LOOKALIKE = settings.lookalikes.number;
const readNum = (s) => Number([...s].map((c) => LOOKALIKE[c] ?? c).join(""));

// Headers among the rejects, as the book's settings describe them.
const PAGE_HEADER = regex(settings.headers.page);   // running page headers: ignored
const LINE_HEADER = regex(settings.headers.line);
const GAME_HEADER = regex(settings.headers.game);
const RESULT = regex(settings.headers.result);

const events = [
  ...rows.map((r) => ({ type: "row", ...r })),
  ...rejects.flatMap((r) => {
    if (PAGE_HEADER.test(r.text)) return [];
    if (RESULT.test(r.text)) return [{ type: "result", page: r.page, y: r.y, text: r.text }];
    if (LINE_HEADER.test(r.text)) return [{ type: "header", kind: "line", page: r.page, y: r.y, text: r.text }];
    if (GAME_HEADER.test(r.text)) return [{ type: "header", kind: "game", page: r.page, y: r.y, text: r.text }];
    return [];
  }),
].sort((a, b) => a.page - b.page || a.y - b.y);

// Where the half-move after `last` belongs.
const after = (last) => (last.side === "w" ? { n: last.n, side: "b" } : { n: last.n + 1, side: "w" });
const firstSide = (r) => (r.white !== null ? "w" : "b");
const lastOfRow = (n, r) => ({ n, side: r.black !== null ? "b" : "w" });
// Does row b carry on directly from row a (numbers na, nb)?
const continues = (na, a, nb, b) => {
  const want = after(lastOfRow(na, a));
  return nb === want.n && firstSide(b) === want.side;
};

const games = [];
let game = null;
let title = null; // header lines seen since the last move row

function startGame(kind, lines, page) {
  game = { id: 0, kind, title: lines, page, start: null, result: null, moves: [], gaps: [], dropped: [] };
  games.push(game);
}

function addRow(r, n, white) {
  const last = game.moves.at(-1);
  if (last) {
    const want = after(last);
    const missing = (n - want.n) * 2 + (firstSide(r) === "b") - (want.side === "b");
    if (missing !== 0) game.gaps.push({ after: `${last.n}${last.side}`, missing, page: r.page });
  }
  if (game.start === null) game.start = n;
  if (white !== null) game.moves.push({ n, side: "w", raw: white, page: r.page });
  if (r.black !== null) game.moves.push({ n, side: "b", raw: r.black, page: r.page });
}

// The next move row after index i, if no header comes first.
function nextRow(i) {
  for (let j = i + 1; j < events.length; j++) {
    if (events[j].type === "header") return null;
    if (events[j].type === "row") return events[j];
  }
  return null;
}

for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (e.type === "header") {
    // Header lines in a row (players, place + year) form one title.
    if (title && title.kind === e.kind) title.lines.push(e.text);
    else title = { kind: e.kind, lines: [e.text] };
    continue;
  }
  if (e.type === "result") {
    if (game?.moves.length) game.result = e.text;
    continue;
  }

  let n = readNum(e.num);
  let white = e.white;
  if (title || !game) {
    startGame(title?.kind ?? "fragment", title?.lines ?? [], e.page);
    title = null;
    addRow(e, n, white);
    continue;
  }

  const last = game.moves.at(-1);
  const want = last ? after(last) : null;
  // "208el" → 20 + "8el"
  if (want && n !== want.n && white !== null) {
    const d = String(readNum(e.num)), w = String(want.n);
    if (d.length > w.length && d.startsWith(w)) {
      white = e.num.slice(w.length) + white;
      n = want.n;
    }
  }
  if (!want || (n === want.n && firstSide(e) === want.side)) {
    addRow(e, n, white);
    continue;
  }

  // Does not fit. Ask the next row.
  const next = nextRow(i);
  const nextN = next ? readNum(next.num) : NaN;
  const real = next && Number.isFinite(n) && continues(n, e, nextN, next);
  if (real) {
    if (n === 1 || n < want.n) {
      // Starts again: a new game without a header (from 1) or a quoted fragment.
      startGame(n === 1 ? "game" : "fragment", [], e.page);
      addRow(e, n, white);
    } else {
      addRow(e, n, white); // a gap: lines were lost
    }
  } else if (firstSide(e) === want.side && !(next && readNum(next.num) === want.n && firstSide(next) === want.side)) {
    // (if the next row is the expected move itself, this row is noise)
    addRow(e, want.n, white); // the number is damaged, the row is where it should be
  } else {
    game.dropped.push(e.text);
  }
}

// A titled game that starts in the middle, straight after a group ending one
// move before it, is the continuation of that group's moves (the chapter's
// theory line is the start of the game).
for (let i = 1; i < games.length; i++) {
  const g = games[i], prev = games[i - 1];
  const last = prev.moves.at(-1), first = g.moves[0];
  if (g.kind === "game" && g.start > 1 && last && first) {
    const want = after(last);
    if (want.n === first.n && want.side === first.side) {
      g.moves = [...prev.moves.map((m) => ({ ...m })), ...g.moves];
      g.start = prev.start;
      g.from = prev;
    }
  }
}

// Drop groups with almost no moves (index pages, captions).
const kept = games.filter((g) => g.moves.length >= 4);
kept.forEach((g, i) => (g.id = i + 1));
for (const g of kept) if (g.from) g.from = g.from.id;
writeJsonl(dir, "3-games.jsonl", kept);

const count = (k) => kept.filter((g) => g.kind === k).length;
const half = kept.reduce((s, g) => s + g.moves.length, 0);
const complete = kept.filter((g) => g.kind === "game" && g.start === 1 && g.gaps.length === 0).length;
console.log(`step 3: ${count("game")} games, ${count("line")} theory lines, ${count("fragment")} fragments, ` +
  `${half} moves; ${complete} games complete from move 1 without gaps; ` +
  `${games.length - kept.length} tiny groups left out → ${dir}/3-games.jsonl`);
