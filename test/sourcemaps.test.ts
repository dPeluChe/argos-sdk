// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONCURRENCY,
  MAX_FILE_BYTES,
  collect,
  resolveConfig,
  run,
  UsageError,
} from '../src/cli/sourcemaps.js';

const TOKEN = 'argos_up_s3cr3t-token-value';
const BASE_ENV = { ARGOS_API_URL: 'https://argos.test', ARGOS_UPLOAD_TOKEN: TOKEN };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'argos-sourcemaps-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string | Buffer = 'x'): Promise<void> {
  const full = join(root, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

interface Call {
  url: URL;
  init: RequestInit;
}

function harness(
  respond: (call: Call, index: number) => Promise<Response> | Response = () => json(201),
) {
  const calls: Call[] = [];
  const lines: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init: init ?? {} };
    const index = calls.push(call) - 1;
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await respond(call, index);
    } finally {
      inFlight--;
    }
  }) as typeof globalThis.fetch;
  const io = {
    fetch,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(l),
    sleep: () => Promise.resolve(),
  };
  return { io, calls, lines, peak: () => peak };
}

function json(status: number): Response {
  return new Response(JSON.stringify({ id: 'f1' }), { status });
}

describe('resolveConfig', () => {
  it('prefers flags over env', () => {
    const config = resolveConfig(
      [
        'upload',
        '--release',
        'r1',
        '--api',
        'https://flag.test/',
        '--project',
        '7',
        '--token',
        't',
        'dist',
      ],
      { ...BASE_ENV, ARGOS_RELEASE: 'env', ARGOS_DSN: 'https://k@x.test/9' },
    );
    expect(config).toMatchObject({
      release: 'r1',
      api: 'https://flag.test',
      project: '7',
      token: 't',
      dirs: ['dist'],
    });
  });

  it('falls back to env, reading the project from the DSN', () => {
    const config = resolveConfig(['upload', 'a', 'b'], {
      ...BASE_ENV,
      ARGOS_RELEASE: 'web@1.2.3',
      ARGOS_DSN: 'https://pub@ingest.test/prefix/42',
    });
    expect(config).toMatchObject({
      release: 'web@1.2.3',
      project: '42',
      token: TOKEN,
      dirs: ['a', 'b'],
    });
  });

  it('parses --dsn', () => {
    expect(
      resolveConfig(
        ['upload', '--release', 'r', '--dsn', 'http://k@localhost:8080/5', 'd'],
        BASE_ENV,
      ).project,
    ).toBe('5');
  });

  it.each([
    ['release', ['upload', '--project', '1', 'd'], BASE_ENV],
    ['api', ['upload', '--release', 'r', '--project', '1', 'd'], { ARGOS_UPLOAD_TOKEN: 't' }],
    ['project', ['upload', '--release', 'r', 'd'], BASE_ENV],
    [
      'token',
      ['upload', '--release', 'r', '--project', '1', 'd'],
      { ARGOS_API_URL: 'https://a.test' },
    ],
    ['a dir', ['upload', '--release', 'r', '--project', '1'], BASE_ENV],
    ['a valid DSN', ['upload', '--release', 'r', '--dsn', 'nonsense', 'd'], BASE_ENV],
    ['a known command', ['push', '--release', 'r', '--project', '1', 'd'], BASE_ENV],
  ])('requires %s', (_what, argv, env) => {
    expect(() => resolveConfig(argv, env)).toThrow(UsageError);
  });

  it('does not need a token for a dry run', () => {
    expect(
      resolveConfig(['upload', '--dry-run', '--release', 'r', '--project', '1', 'd'], {
        ARGOS_API_URL: 'https://a.test',
      }).token,
    ).toBe('');
  });
});

describe('collect', () => {
  it('names files relative to the given dir with forward slashes, skipping node_modules', async () => {
    await put('dist/assets/app.js.map');
    await put('dist/assets/app.js');
    await put('dist/nested/deep/chunk.mjs.map');
    await put('dist/node_modules/pkg/index.js.map');
    await put('dist/readme.txt');
    const files = await collect([join(root, 'dist')], false);
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ['assets/app.js.map', 'source_map'],
      ['nested/deep/chunk.mjs.map', 'source_map'],
    ]);
  });

  it('pairs each map with the source next to it when asked', async () => {
    await put('d/a.js.map');
    await put('d/a.js');
    await put('d/b.cjs.map');
    await put('d/b.cjs');
    await put('d/c.map');
    await put('d/c.mjs');
    await put('d/orphan.js.map');
    await put('d/unmapped.js');
    const files = await collect([join(root, 'd')], true);
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ['a.js.map', 'source_map'],
      ['a.js', 'source'],
      ['b.cjs.map', 'source_map'],
      ['b.cjs', 'source'],
      ['c.map', 'source_map'],
      ['c.mjs', 'source'],
      ['orphan.js.map', 'source_map'],
    ]);
  });
});

describe('run', () => {
  const argv = (...extra: string[]) => [
    'upload',
    '--release',
    'web@1.0 beta',
    '--project',
    '42',
    ...extra,
    join(root, 'dist'),
  ];

  it('posts each file raw with the bearer token to the release files route', async () => {
    await put('dist/assets/app.js.map', '{"version":3}');
    const h = harness();
    expect(await run(argv(), BASE_ENV, h.io)).toBe(0);
    const [call] = h.calls;
    expect(call.url.origin + call.url.pathname).toBe(
      'https://argos.test/api/projects/42/releases/web%401.0%20beta/files',
    );
    expect(call.url.searchParams.get('name')).toBe('assets/app.js.map');
    expect(call.url.searchParams.get('kind')).toBe('source_map');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/octet-stream',
    });
    expect(Buffer.from(call.init.body as Uint8Array).toString()).toBe('{"version":3}');
    expect(h.lines.at(-1)).toMatch(/^1 uploaded, 0 skipped, 0 failed/);
  });

  it(`never has more than ${String(CONCURRENCY)} uploads in flight`, async () => {
    for (let i = 0; i < 12; i++) await put(`dist/f${String(i)}.js.map`);
    const h = harness();
    expect(await run(argv(), BASE_ENV, h.io)).toBe(0);
    expect(h.calls).toHaveLength(12);
    expect(h.peak()).toBe(CONCURRENCY);
  });

  it('retries once on a 5xx or a network error', async () => {
    await put('dist/a.js.map');
    await put('dist/b.js.map');
    const h = harness((call, i) => {
      if (i < 2) {
        if (call.url.searchParams.get('name') === 'a.js.map') return json(503);
        throw new TypeError('fetch failed');
      }
      return json(201);
    });
    expect(await run(argv(), BASE_ENV, h.io)).toBe(0);
    expect(h.calls).toHaveLength(4);
  });

  it('fails a file after the retry also fails, and exits non-zero', async () => {
    await put('dist/a.js.map');
    const h = harness(() => json(500));
    expect(await run(argv(), BASE_ENV, h.io)).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.lines.at(-1)).toMatch(/0 uploaded, 0 skipped, 1 failed/);
  });

  it('aborts on 401 without sending the rest', async () => {
    for (let i = 0; i < 10; i++) await put(`dist/f${String(i)}.js.map`);
    const h = harness(() => json(401));
    expect(await run(argv(), BASE_ENV, h.io)).toBe(1);
    expect(h.calls.length).toBeLessThanOrEqual(CONCURRENCY);
    expect(h.lines.join('\n')).toMatch(/aborted: 401: the upload token was rejected/);
  });

  it('aborts on 404 with a project hint', async () => {
    await put('dist/a.js.map');
    const h = harness(() => json(404));
    expect(await run(argv(), BASE_ENV, h.io)).toBe(1);
    expect(h.lines.join('\n')).toMatch(/404: project not found/);
  });

  it('does not retry a 413, and counts it failed', async () => {
    await put('dist/a.js.map');
    const h = harness(() => json(413));
    expect(await run(argv(), BASE_ENV, h.io)).toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  it('skips files over 20 MiB with a warning, without failing', async () => {
    await put('dist/huge.js.map', Buffer.alloc(MAX_FILE_BYTES + 1));
    await put('dist/ok.js.map');
    const h = harness();
    expect(await run(argv(), BASE_ENV, h.io)).toBe(0);
    expect(h.calls.map((c) => c.url.searchParams.get('name'))).toEqual(['ok.js.map']);
    expect(h.lines.join('\n')).toMatch(/skipped\s+huge\.js\.map .* larger than 20 MiB/);
  });

  it('lists without sending on --dry-run', async () => {
    await put('dist/a.js.map');
    await put('dist/a.js');
    const h = harness();
    expect(
      await run(
        argv('--dry-run', '--include-sources'),
        { ARGOS_API_URL: 'https://argos.test' },
        h.io,
      ),
    ).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.lines).toEqual([
      expect.stringMatching(/would upload\s+a\.js\.map .* source_map/),
      expect.stringMatching(/would upload\s+a\.js .* source$/),
      expect.stringMatching(/^2 files .*\(dry run\)$/),
    ]);
  });

  it('exits 2 on bad usage and 1 when there is nothing to upload', async () => {
    const h = harness();
    expect(await run(['upload', join(root, 'dist')], BASE_ENV, h.io)).toBe(2);
    await mkdir(join(root, 'dist'));
    expect(await run(argv(), BASE_ENV, h.io)).toBe(1);
  });

  it('never prints the token, even when a server error echoes it back', async () => {
    await put('dist/a.js.map');
    const h = harness(() => {
      throw new TypeError(`connect refused, Authorization: Bearer ${TOKEN}`);
    });
    expect(await run(argv('--token', TOKEN), { ARGOS_API_URL: 'https://argos.test' }, h.io)).toBe(
      1,
    );
    const output = h.lines.join('\n');
    expect(output).toContain('***');
    expect(output).not.toContain(TOKEN);
  });
});
