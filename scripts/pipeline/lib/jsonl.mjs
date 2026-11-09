// Small helpers shared by the Node steps: read and write JSONL, stop with a message.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fail(step, msg) {
  console.error(`step ${step}: ${msg}`);
  process.exit(1);
}

// Reads <dir>/<name>; every line must be a JSON object.
export function readJsonl(step, dir, name) {
  const file = join(dir, name);
  if (!existsSync(file)) fail(step, `needs ${file}: run the step before first`);
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      return fail(step, `${name} line ${i + 1} is not JSON`);
    }
  });
}

export function readJson(step, dir, name) {
  const file = join(dir, name);
  if (!existsSync(file)) fail(step, `needs ${file}: run the step before first`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJsonl(dir, name, items) {
  writeFileSync(join(dir, name), items.map((x) => JSON.stringify(x) + "\n").join(""));
}

// Two amounts are the same if they differ by less than half a cent.
export const TOLERANCE = 0.005;
export const same = (a, b) => Math.abs(a - b) < TOLERANCE;
