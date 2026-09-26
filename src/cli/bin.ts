import { run } from './sourcemaps.js';

process.exitCode = await run(process.argv.slice(2), process.env, {
  fetch: globalThis.fetch,
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
});
