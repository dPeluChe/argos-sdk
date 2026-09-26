import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/server/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    // The CLI build writes into dist/cli in parallel; never wipe it from here.
    clean: ['!cli/**'],
    treeshake: true,
    sourcemap: true,
    target: 'es2022',
    define: { __ARGOS_VERSION__: JSON.stringify(version) },
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  },
  // Separate build so the CLI shares no chunk with, and adds no byte to, the browser bundle.
  {
    entry: { 'cli/sourcemaps': 'src/cli/bin.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
