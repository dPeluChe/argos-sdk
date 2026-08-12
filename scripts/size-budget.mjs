import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';

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
 * Raise these deliberately, in the commit that needs the room, with the reason
 * in the message. Never to make a build pass.
 */
const BUDGETS = [
  { file: 'dist/index.js', maxRawBytes: 32_000, maxGzipBytes: 11_000 },
  { file: 'dist/index.cjs', maxRawBytes: 33_000, maxGzipBytes: 11_500 },
];

let failed = false;

for (const { file, maxRawBytes, maxGzipBytes } of BUDGETS) {
  const raw = statSync(file).size;
  const gzip = gzipSync(readFileSync(file)).length;
  const over = raw > maxRawBytes || gzip > maxGzipBytes;
  failed ||= over;

  const pct = Math.round((gzip / maxGzipBytes) * 100);
  console.log(
    `${over ? 'OVER  ' : 'ok    '}${file}  raw ${raw}/${maxRawBytes}  gzip ${gzip}/${maxGzipBytes}  (${String(pct)}% of the gzip budget)`,
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
