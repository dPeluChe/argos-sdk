import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/server/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    // The CLI and agents builds write into dist/cli and dist/agents in parallel; never wipe them here.
    clean: ['!cli/**', '!agents/**'],
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
  // Same reason: as an entry of the first build, a shared chunk was split out and
  // added 330 bytes of chunk plumbing to the browser bundle.
  {
    entry: { 'agents/index': 'src/agents/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    define: { __ARGOS_VERSION__: JSON.stringify(version) },
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  },
]);
