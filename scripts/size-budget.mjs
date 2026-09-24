import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The bundle is the price every visitor of every instrumented page pays, on
 * their connection, before anything of ours is useful to them. Without a
 * ceiling it only ever goes up, one reasonable-looking dependency at a time,
 * and nobody notices because no single commit is the one that broke it.
 *
 * Gzip is the number that matters — it is what actually crosses the wire — and
 * the raw size is checked too, because that is what has to be parsed on a
 * phone, where parsing costs more than downloading.
 *
 * **Imports are followed.** Adding a second entry point made the browser file
 * shrink by seven kilobytes that had merely moved into a shared chunk it still
 * imports. A budget that can be satisfied by moving code sideways is not a
 * budget, so what is measured is the entry plus everything it pulls in.
 *
 * Raise these deliberately, in the commit that needs the room, with the reason
 * in the message. Never to make a build pass.
 */
// 0.9: +2.5 KB raw / +300 B gzip for debug mode, baggage merging and async beforeSend.
// Startup heartbeat: +1.5 KB raw / +400 B gzip (daily gate, Sentry detection, payload).
const BUDGETS = [
  { entry: 'dist/index.js', maxRawBytes: 38_000, maxGzipBytes: 12_200 },
  { entry: 'dist/index.cjs', maxRawBytes: 38_000, maxGzipBytes: 12_200 },
];

const IMPORT = /from\s*['"](\.[^'"]+)['"]/g;

/** Every file the entry loads, itself included, without repeats. */
function graph(entry, seen = new Set()) {
  const path = resolve(entry);
  if (seen.has(path)) return seen;
  seen.add(path);
  const source = readFileSync(path, 'utf8');
  for (const [, specifier] of source.matchAll(IMPORT)) {
    graph(resolve(dirname(path), specifier), seen);
  }
  return seen;
}

let failed = false;

for (const { entry, maxRawBytes, maxGzipBytes } of BUDGETS) {
  const files = [...graph(entry)];
  const raw = files.reduce((total, file) => total + statSync(file).size, 0);
  const gzip = files.reduce((total, file) => total + gzipSync(readFileSync(file)).length, 0);
  const over = raw > maxRawBytes || gzip > maxGzipBytes;
  failed ||= over;

  const pct = Math.round((gzip / maxGzipBytes) * 100);
  const shape = files.length > 1 ? ` (${String(files.length)} files)` : '';
  console.log(
    `${over ? 'OVER  ' : 'ok    '}${entry}${shape}  raw ${raw}/${maxRawBytes}  gzip ${gzip}/${maxGzipBytes}  (${String(pct)}% of the gzip budget)`,
  );
}

if (failed) {
  console.error(
    '\nThe bundle grew past its budget. Either take the weight back out, or raise\n' +
      'the number in scripts/size-budget.mjs in the same commit, saying what bought\n' +
      'the room. A budget quietly raised to make a build pass is not a budget.',
  );
  process.exit(1);
}
