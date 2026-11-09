# kung-fu-chess

> **Work in progress.** The pipeline runs end to end on one test book. The
> results are promising but not finished, and the scripts and settings still
> change often.

This project turns a scanned chess book (PDF) into chess games you can open in
any chess program (PGN).

Scanned books often come with a hidden OCR text layer, but the OCR makes
mistakes: `cS` instead of `c5`, `NhJ` instead of `Nh3`, `tONeS` instead of
`10 Ne5`. This project does not try to guess every mistake by hand. It lets
the chess board decide: each printed move is read as the **legal** move it most
resembles, and the moves after it confirm or reject that reading.

## How it works

The pipeline runs in steps. Each step reads the files the step before it
wrote, so you can run and inspect them one at a time.

| Step | Script | What it does | Writes |
|------|--------|--------------|--------|
| 1 | `1-read.mjs` | Reads every PDF page into text lines with their positions on the page | `0-settings.json`, `1-lines.jsonl` |
| 2 | `2-moves.mjs` | Finds the move lines (move number, White's move, Black's move in two columns) and keeps the raw OCR text | `2-moves.jsonl`, `2-rejects.jsonl` |
| 3 | `3-games.mjs` | Groups the move lines into games, using the headers (players, place, year) and the move numbers | `3-games.jsonl` |
| 4 | `4-replay.mjs` | Replays every game on a board and reads each printed move as a legal move; fills short gaps | `4-games.jsonl`, `games.pgn` |

All output goes to `.cache/pipeline/<book name>/`.

### Step 4 in more detail

- **Reading cost.** Each way of reading a printed move as a legal move gets a
  cost. A common OCR look-alike (`S` → 5) costs 1, a rare one (`l` → 2) costs 2.
  A reading above the limit is not allowed, so one piece is never swapped for
  another just to make a game fit.
- **Beam search.** One move at a time is not enough: `Nil` could be Nf1 or Nf2,
  and only later moves show which one. The replay keeps the 30 cheapest move
  sequences side by side and lets the later moves decide.
- **Gaps.** When the book is missing a move, every legal move is tried, and the
  following printed moves keep only the ones that fit.
- **Guesses.** A move too damaged to read is matched loosely and marked as
  `guessed`, so it can be checked by hand.

## Setup

Needs Node.js 24 or newer.

```sh
npm install
```

The libraries are [pdfjs-dist](https://github.com/mozilla/pdf.js) (reading the
PDF) and [chess.js](https://github.com/jhlywa/chess.js) (the board and the legal
moves).

## Running

```sh
BOOK=my-book.pdf
OUT=.cache/pipeline/my-book

node scripts/pipeline/1-read.mjs   $BOOK $OUT books/my-book.json
node scripts/pipeline/2-moves.mjs  $OUT
node scripts/pipeline/3-games.mjs  $OUT
node scripts/pipeline/4-replay.mjs $OUT
```

Step 4 takes a few minutes on a full book.

**Books are not included in this repository.** Use your own PDF. It must have a
text layer: a scan with only page images needs OCR first.

## Book settings

Each book is printed differently, so everything specific to a book lives in its
own file, `books/<name>.json`. The scripts themselves hold no book-specific
values.

- **Defaults** are in [`scripts/pipeline/lib/settings.mjs`](scripts/pipeline/lib/settings.mjs).
- **A book's file** overrides only the values that differ:
  - `layout`: where the move columns sit on the page
  - `headers`: what game titles, chapter headings and page headers look like
  - `lookalikes`: the OCR look-alikes for move numbers and moves
- **Step 1 copies** the combined settings into the output folder
  (`0-settings.json`), so every result records the settings it was made with.

See [`books/stonewall-attack.json`](books/stonewall-attack.json) for an example.

## Current status

Test book: Andrew Soltis, *The Stonewall Attack* (Chess Digest, 1993), 156
scanned pages.

- 37 groups found: 29 games, 7 opening-theory lines and 1 side game
- **26 replay as fully legal games** to the end
- 6 stop partway, at moves the scan damaged too badly
- 5 are skipped because they start in the middle of a game, so there is no
  start position to play from

**Legal does not mean correct.** A game with guessed moves can still contain a
wrong move that happens to be legal. Games with a low total reading cost and no
guesses can be trusted most.

## Known limitations

- Only the **two-column layout** (move number + White | Black) is read. Moves
  written inside the text, such as side lines in the notes, are not extracted
  yet.
- **Not supported yet:**
  - figurine notation (piece symbols instead of letters)
  - descriptive notation (`P-K4`)
  - books that print moves in one running line (`1.d4 d5 2.c4 e6`)
- Tested on **one book** so far.

## To do

- [ ] Check guessed moves against the page images
- [ ] Make step 4 faster
- [ ] `run.mjs` to run all steps with one command
- [ ] Extract moves written inside the text
- [ ] Try a second book with a different layout
