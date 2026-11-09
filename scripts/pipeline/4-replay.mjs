// Step 4, replay: play every game on a board. Each printed move is OCR text,
// so it is matched against the LEGAL moves in that position. One move at a
// time is not enough: "Nil" may read as Nf1 or Nf2, and only later moves show
// which one leaves castling possible. So the replay keeps the best BEAM move
// sequences side by side (a beam search) and lets the later moves decide:
// the whole game must be legal, not just each move. A gap (moves missing in
// the book) is filled the same way: every legal move is tried and the printed
// moves after it keep only the ones that fit.
//
// Run: node scripts/pipeline/4-replay.mjs <output folder>
// Reads 0-settings.json, 3-games.jsonl. Writes:
//   4-games.jsonl  one per group: { id, kind, title, page, status, moves, cost, fixes, filled, unsure, stop? }
//     status  "legal"    every printed move read as a legal move, to the end
//             "stopped"  from here no reading of the printed move is legal in any
//                        kept sequence: the moves before it are kept, stop says where
//             "skipped"  starts after move 1 (a fragment): no start position to play from
//     moves   the moves in standard notation (SAN), as far as the replay got
//     cost    total reading cost of the chosen sequence (0 = printed exactly as SAN)
//     fixes   moves whose print was not already standard: { n, side, raw, san, cost }
//     filled  moves missing in the book, found by the replay: { n, side, san }
//     guessed moves printed too damaged to read within MAX_COST: the replay allows
//             a loose reading (up to GUESS_COST) and the later moves decide
//             { n, side, raw, san, cost }; at most MAX_GUESSES per game
//     unsure  moves where another sequence, just as cheap, plays something else
//   games.pgn      every game and line, as far as it is legal
//
// Reading cost of a printed move as a legal move:
//   0  same text once annotations are removed (!, ?, ch, +, mate, e.p.)
//   1  per OCR look-alike (settings.lookalikes.move: S read as 5 or 8, J as 3, ...)
//   2  per rare look-alike (settings.lookalikes.rare: l read as 2, C as f, ...)
//   1  per x or = the print leaves out ("NeS" for Nxe5); 2 for any other
//      character the print leaves out (a lost piece letter)
//   2  per extra character in the print (a speck)
//   0  for a from-square letter SAN does not need ("Radl" = Rd1, "Ndf3" = Nf3):
//      the print is also compared with the long forms of the move
//   pawn captures written by files only ("cd", "hg e.p.") are read as from-file + to-file
// A reading costing more than MAX_COST is not considered. MAX_COST 3 means an
// arbitrary letter swap (left out 2 + speck 2 = 4) never counts: only look-alikes do.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";
import { fail, readJsonl, writeJsonl } from "./lib/jsonl.mjs";
import { loadSettings } from "./lib/settings.mjs";

const dir = process.argv[2];
if (!dir) fail(4, "usage: node scripts/pipeline/4-replay.mjs <output folder>");
const settings = loadSettings(4, dir);
const games = readJsonl(4, dir, "3-games.jsonl");

const MAX_COST = 3;  // most a single printed move may cost to read
const BEAM = 30;     // move sequences kept side by side
const WIDE = 600;    // ... for the WIDE_FOR printed moves after a filled gap, when
const WIDE_FOR = 4;  //     every legal move was tried and many sequences cost the same
const FILL_COST = 3; // cost of a move the book left out
const MAX_FILL = 2;  // longest gap (half-moves) the replay tries to fill
const GUESS_COST = 6;  // loosest reading allowed for a move that cannot be read otherwise
const MAX_GUESSES = 3; // per game; more than that and the game stops

// Look-alikes: printed piece of text (1-2 characters) → characters it may stand for.
const LOOK = [
  ...Object.entries(settings.lookalikes.move).map(([from, to]) => [from, new Set(to), 1]),
  ...Object.entries(settings.lookalikes.rare ?? {}).map(([from, to]) => [from, new Set(to), 2]),
];

// Remove what is not part of the move itself.
function clean(raw) {
  return raw
    .replace(/\s+/g, "")
    .replace(/\((\w)\)/, "=$1")                      // cxb8(Q) → cxb8=Q
    .replace(/(e\.?p\.?)$/i, "")
    .replace(/[,.;:'"·•]+$/g, "")
    .replace(/(dbl\.?ch|ch|cb|c"|mate|\+\+?|#)?[!?]*$/i, "")
    .replace(/[!?]+/g, "")
    .replace(/^[0O]-[0O]-[0O]$/, "O-O-O")
    .replace(/^[0O]-[0O]$/, "O-O");
}

// Cheapest way to read printed text p as s (edit distance with OCR costs).
// The same pairs come up again and again across the beam, so results are kept.
const costCache = new Map();
function cost(p, s) {
  const key = p + "\u0000" + s;
  let c = costCache.get(key);
  if (c === undefined) costCache.set(key, (c = editCost(p, s)));
  return c;
}

function editCost(p, s) {
  const INF = 99;
  const d = Array.from({ length: p.length + 1 }, () => new Array(s.length + 1).fill(INF));
  d[0][0] = 0;
  for (let i = 0; i <= p.length; i++) {
    for (let j = 0; j <= s.length; j++) {
      const here = d[i][j];
      if (here >= INF) continue;
      if (i < p.length && j < s.length) {
        if (p[i] === s[j]) d[i + 1][j + 1] = Math.min(d[i + 1][j + 1], here);
        for (const [from, to, c] of LOOK) {
          if (to.has(s[j]) && p.startsWith(from, i))
            d[i + from.length][j + 1] = Math.min(d[i + from.length][j + 1], here + c);
        }
      }
      if (j < s.length) d[i][j + 1] = Math.min(d[i][j + 1], here + (s[j] === "x" || s[j] === "=" ? 1 : 2));
      if (i < p.length) d[i + 1][j] = Math.min(d[i + 1][j], here + 2);
    }
  }
  return d[p.length][s.length];
}

const san0 = (san) => san.replace(/[+#]$/, "");

// Legal moves this printed text can be read as, with their cost (<= MAX_COST).
function readings(board, raw, maxCost = MAX_COST) {
  const p = clean(raw);
  const pawnFiles = /^[a-zA-Z]{2}$/.test(p) && !/[KQRBN]/.test(p);
  const out = [];
  for (const m of board.moves({ verbose: true })) {
    const san = san0(m.san);
    let c = cost(p, san);
    if (m.piece !== "p" && !san.startsWith("O-O")) {
      // long forms: "Rd1" also as "Rad1" and "R1d1"
      const piece = san[0], rest = san.slice(1).replace(/^[a-h1-8](?=x?[a-h][1-8])/, "");
      c = Math.min(c, cost(p, piece + m.from[0] + rest), cost(p, piece + m.from[1] + rest));
    }
    if (pawnFiles && m.piece === "p" && m.captured) c = Math.min(c, cost(p, m.from[0] + m.to[0]));
    if (c <= maxCost) out.push({ san: m.san, cost: c });
  }
  return out;
}

// For a stop: the closest readings, ignoring MAX_COST.
function closest(board, raw) {
  const p = clean(raw);
  return board.moves().map((san) => ({ san, cost: cost(p, san0(san)) }))
    .sort((a, b) => a.cost - b.cost).slice(0, 3);
}

// Keep the cheapest state per position, then the `limit` cheapest overall.
function keep(states, limit = BEAM) {
  const best = new Map();
  for (const st of states) {
    const key = st.fen + "|" + st.steps.length;
    if (!best.has(key) || best.get(key).cost > st.cost) best.set(key, st);
  }
  return [...best.values()].sort((a, b) => a.cost - b.cost).slice(0, limit);
}

function play(st, san, step) {
  const board = new Chess(st.fen);
  board.move(san);
  return { fen: board.fen(), cost: st.cost + step.cost, steps: [...st.steps, { ...step, san }] };
}

function replay(g) {
  const gapAt = new Map(g.gaps.map((x) => [x.after, x.missing]));
  let beam = [{ fen: new Chess().fen(), cost: 0, steps: [] }];
  let wide = 0; // printed moves left that get the wide beam
  for (const m of g.moves) {
    let next = [];
    for (const st of beam)
      for (const r of readings(new Chess(st.fen), m.raw))
        next.push(play(st, r.san, { n: m.n, side: m.side, raw: m.raw, cost: r.cost }));
    if (next.length === 0) {
      // Unreadable: a loose reading, decided by the moves after it.
      for (const st of beam) {
        if (st.steps.filter((x) => x.guess).length >= MAX_GUESSES) continue;
        for (const r of readings(new Chess(st.fen), m.raw, GUESS_COST))
          next.push(play(st, r.san, { n: m.n, side: m.side, raw: m.raw, cost: r.cost, guess: true }));
      }
      if (next.length) wide = WIDE_FOR + 1;
    }
    if (next.length === 0) {
      return { beam: keep(beam), stop: { n: m.n, side: m.side, raw: m.raw, page: m.page,
        why: "no reading of this move is legal after the moves before it",
        near: closest(new Chess(keep(beam)[0].fen), m.raw) } };
    }
    beam = keep(next, wide > 0 ? WIDE : BEAM);
    if (wide > 0) wide--;

    const missing = gapAt.get(`${m.n}${m.side}`);
    if (missing) {
      if (missing < 0 || missing > MAX_FILL) {
        return { beam, stop: { n: m.n, side: m.side, raw: null, page: m.page,
          why: `${missing} move(s) missing in the book after this one: too many to fill` } };
      }
      let n = m.n, side = m.side;
      for (let k = 0; k < missing; k++) {
        [n, side] = side === "w" ? [n, "b"] : [n + 1, "w"];
        const filled = [];
        for (const st of beam)
          for (const san of new Chess(st.fen).moves())
            filled.push(play(st, san, { n, side, raw: null, cost: FILL_COST }));
        beam = filled; // not cut: the next printed moves decide
      }
      wide = WIDE_FOR;
    }
  }
  return { beam: keep(beam) };
}

const out = [];
for (const g of games) {
  const res = { id: g.id, kind: g.kind, title: g.title, page: g.page, result: g.result,
    status: "legal", moves: [], cost: 0, fixes: [], filled: [], guessed: [], unsure: [] };
  out.push(res);
  if (g.start !== 1) {
    res.status = "skipped";
    res.why = `starts at move ${g.start}: the moves before it are not in the columns`;
    continue;
  }
  const { beam, stop } = replay(g);
  const best = beam[0];
  if (stop) Object.assign(res, { status: "stopped", stop });
  res.moves = best.steps.map((s) => s.san);
  res.cost = best.cost;
  res.board = best.fen;
  for (const s of best.steps) {
    if (s.raw === null) res.filled.push({ n: s.n, side: s.side, san: s.san });
    else if (s.guess) res.guessed.push({ n: s.n, side: s.side, raw: s.raw, san: s.san, cost: s.cost });
    else if (s.cost > 0 || clean(s.raw) !== san0(s.san))
      res.fixes.push({ n: s.n, side: s.side, raw: s.raw, san: s.san, cost: s.cost });
  }
  // Unsure: another kept sequence, just as cheap, that plays something else.
  for (const other of beam.slice(1)) {
    if (other.cost !== best.cost) break;
    other.steps.forEach((s, i) => {
      if (best.steps[i] && s.san !== best.steps[i].san && !res.unsure.some((u) => u.n === s.n && u.side === s.side))
        res.unsure.push({ n: s.n, side: s.side, raw: s.raw, chosen: best.steps[i].san, other: s.san });
    });
  }
}

writeJsonl(dir, "4-games.jsonl", out);
writeFileSync(join(dir, "games.pgn"), out.filter((g) => g.moves.length).map(pgn).join("\n"));

const by = (s) => out.filter((g) => g.status === s).length;
const sum = (f) => out.reduce((s, g) => s + f(g), 0);
console.log(`step 4: ${by("legal")} legal to the end, ${by("stopped")} stopped, ${by("skipped")} skipped; ` +
  `${sum((g) => g.moves.length)} legal moves (${sum((g) => g.fixes.length)} read through OCR, ` +
  `${sum((g) => g.filled.length)} filled into gaps, ${sum((g) => g.guessed.length)} guessed, ${sum((g) => g.unsure.length)} unsure) → ${dir}/4-games.jsonl, games.pgn`);

function pgn(g) {
  const tags = [
    ["Event", g.title.join(" / ") || `${g.kind} on page ${g.page}`],
    ["Site", `page ${g.page}`],
    ["Result", "*"],
  ];
  let text = "";
  g.moves.forEach((san, i) => {
    if (i % 2 === 0) text += `${i / 2 + 1}. `;
    text += san + " ";
  });
  if (g.status === "stopped") text += `{stopped at ${g.stop.n}${g.stop.side === "b" ? "..." : "."} "${g.stop.raw ?? ""}": ${g.stop.why}} `;
  else if (g.result) text += `{${g.result}} `;
  return tags.map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`).join("\n") + "\n\n" + wrap(text + "*") + "\n";
}

function wrap(s) {
  const lines = [];
  let line = "";
  for (const w of s.split(" ")) {
    if (line && (line + " " + w).length > 79) { lines.push(line); line = w; }
    else line = line ? line + " " + w : w;
  }
  return [...lines, line].join("\n");
}
