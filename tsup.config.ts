import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts', 'src/server/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: 'es2022',
  define: { __ARGOS_VERSION__: JSON.stringify(version) },
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
