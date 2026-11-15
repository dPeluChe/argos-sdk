// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BYTES = Buffer.from('tarball bytes');
const SRI = `sha512-${createHash('sha512').update(BYTES).digest('base64')}`;
const SHA256 = createHash('sha256').update(BYTES).digest('hex');
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'argos-release-'));
  await writeFile(join(dir, 'argos-browser-1.0.0.tgz'), BYTES);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function notes(existing: string): { tag_name: string; name: string; body: string } {
  const run = spawnSync(
    'node',
    ['scripts/release-notes.mjs', join(dir, 'argos-browser-1.0.0.tgz'), 'acme/sdk', 'v1.0.0'],
    { input: existing, encoding: 'utf8' },
  );
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as { tag_name: string; name: string; body: string };
}

describe('release notes', () => {
  it('writes the install line and the npm integrity and sha256 of the tarball', () => {
    const out = notes('');

    expect(out.tag_name).toBe('v1.0.0');
    expect(out.name).toBe('v1.0.0');
    expect(out.body).toContain(
      'Install: npm install https://github.com/acme/sdk/releases/download/v1.0.0/argos-browser-1.0.0.tgz',
    );
    expect(out.body).toContain(`- npm integrity: \`${SRI}\``);
    expect(out.body).toContain(`- sha256: \`${SHA256}\``);
  });

  it('keeps the notes someone wrote and replaces only its own block on a re-run', () => {
    const first = notes(JSON.stringify({ id: 7, body: 'Hand written.' })).body;
    const again = notes(JSON.stringify({ id: 7, body: `Top.\n\n${first}\n\nFooter.` })).body;

    expect(first.startsWith('Hand written.')).toBe(true);
    expect(again.startsWith('Top.\n\nHand written.')).toBe(true);
    expect(again.endsWith('Footer.\n\n' + first.slice(first.indexOf('<!--')))).toBe(true);
    expect(again.match(/argos-sdk-checksums -->/g)).toHaveLength(2);
  });
});
