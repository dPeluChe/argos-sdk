import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS } from '../src/transport.js';

const DSN = 'https://0123456789abcdef0123456789abcdef@ingest.example.com/42';
const URL = 'https://ingest.example.com/api/42/heartbeat/';
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

let fetchMock: ReturnType<typeof vi.fn>;

function beats(): { url: string; init: RequestInit; body: Record<string, unknown> }[] {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).includes('/heartbeat/'))
    .map((call) => {
      const init = call[1] as RequestInit;
      return { url: String(call[0]), init, body: JSON.parse(init.body as string) };
    });
}

// The heartbeat is sent one macrotask after init.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// The once-per-period guard is module state, so each test gets fresh modules.
const browser = () => import('../src/index.js');
const server = () => import('../src/server/index.js');

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  // A heartbeat is sent a macrotask after init; one still pending when a test
  // ends would land in the next test's fetch stub. Let it fire here.
  vi.useRealTimers();
  await tick();
  (await browser()).close();
  delete (globalThis as { __SENTRY__?: unknown }).__SENTRY__;
});

describe('server heartbeat', () => {
  it('sends one per process, with what the contract asks and nothing else', async () => {
    const { initServer } = await server();
    initServer({ dsn: DSN, release: 'api@1.2.3' });
    initServer({ dsn: DSN, release: 'api@1.2.3' });
    await tick();

    expect(beats()).toHaveLength(1);
    const [beat] = beats();
    expect(beat.url).toBe(URL);
    expect(new Headers(beat.init.headers).get('X-Argos-Key')).toBe(
      '0123456789abcdef0123456789abcdef',
    );
    expect(beat.body).toEqual({
      environment: 'production',
      release: 'api@1.2.3',
      runtime: 'node',
      sdk: { name: '@argos/browser/server', version },
      sentry: null,
    });
  });

  it('sends nothing with heartbeat: false', async () => {
    const { initServer } = await server();
    initServer({ dsn: DSN, heartbeat: false });
    await tick();

    expect(beats()).toHaveLength(0);
  });

  it('logs the result in debug mode', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { initServer } = await server();
    initServer({ dsn: DSN, debug: true, environment: 'staging' });
    await tick();

    expect(info).toHaveBeenCalledWith('[argos] heartbeat delivered');
    expect(beats()[0].body.environment).toBe('staging');
  });

  it('never throws when the ingest cannot be reached', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { initServer } = await server();

    expect(() => initServer({ dsn: DSN, debug: true })).not.toThrow();
    await vi.runAllTimersAsync();

    expect(info).toHaveBeenCalledWith('[argos] heartbeat failed');
  });
});

describe('browser heartbeat', () => {
  it('sends at most one per browser per day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
    const { init } = await browser();
    init({ dsn: DSN });
    init({ dsn: DSN });
    await tick();

    // A fresh page load the same day: the stored date holds it back.
    vi.resetModules();
    (await browser()).init({ dsn: DSN });
    await tick();
    expect(beats()).toHaveLength(1);
    expect(beats()[0].body).toEqual({
      environment: 'production',
      release: null,
      runtime: 'browser',
      sdk: { name: '@argos/browser', version },
      sentry: null,
    });

    vi.setSystemTime(new Date('2026-09-25T00:00:01Z'));
    vi.resetModules();
    (await browser()).init({ dsn: DSN });
    await tick();
    expect(beats()).toHaveLength(2);
  });

  it('sends once per page load when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    });
    const { init } = await browser();
    init({ dsn: DSN });
    init({ dsn: DSN });
    await tick();

    expect(beats()).toHaveLength(1);
  });

  it('waits for consent when consent is required', async () => {
    const { init, grantConsent } = await browser();
    init({ dsn: DSN, requireConsent: true });
    await tick();
    expect(beats()).toHaveLength(0);

    grantConsent();
    await tick();
    expect(beats()).toHaveLength(1);
  });

  it('sends nothing after a refusal', async () => {
    const { init, revokeConsent } = await browser();
    init({ dsn: DSN, heartbeat: false });
    revokeConsent();
    init({ dsn: DSN });
    await tick();

    expect(beats()).toHaveLength(0);
  });

  it('sends nothing with heartbeat: false', async () => {
    (await browser()).init({ dsn: DSN, heartbeat: false });
    await tick();

    expect(beats()).toHaveLength(0);
  });

  it('never throws when fetch rejects', async () => {
    // Fake timers so every backoff retry runs here: on real timers they post
    // into whichever test's fetch stub is current 250ms+ later.
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const { init } = await browser();

    expect(init({ dsn: DSN })).toBeDefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beats()).toHaveLength(MAX_ATTEMPTS);
  });
});

describe('Sentry detection', () => {
  it('reports the Sentry SDK when one was initialised', async () => {
    const Sentry = await import('@sentry/browser');
    const { init } = await browser();
    init({ dsn: DSN });
    // After ours on purpose: detection runs a tick later.
    Sentry.init({ dsn: 'https://key@sentry.example.com/1', defaultIntegrations: false });
    await tick();

    expect(beats()).toHaveLength(1);
    expect(beats()[0].body.sentry).toEqual({
      name: 'sentry.javascript.browser',
      version: '11.0.0',
    });
    await Sentry.close();
  });

  it('falls back to the carrier version when no client is reachable', async () => {
    (globalThis as { __SENTRY__?: unknown }).__SENTRY__ = { version: '9.1.0', '9.1.0': {} };
    const { initServer } = await server();
    initServer({ dsn: DSN });
    await tick();

    expect(beats()).toHaveLength(1);
    expect(beats()[0].body.sentry).toEqual({ name: 'sentry', version: '9.1.0' });
  });
});

describe('update notice', () => {
  const answering = (latest: string): void => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ accepted: 1, latest_sdk: latest }), { status: 202 }),
    );
  };

  it('warns the developer once when a newer SDK exists', async () => {
    answering('99.0.0');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { initServer } = await server();
    initServer({ dsn: DSN });
    await tick();
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(`${version} is installed and 99.0.0 is available`);
    expect(warn.mock.calls[0]?.[0]).toContain('releases/download/v99.0.0/argos-browser-99.0.0.tgz');
    warn.mockRestore();
  });

  it('says nothing when the install is current', async () => {
    answering(version);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { initServer } = await server();
    initServer({ dsn: DSN });
    await tick();
    await tick();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('updateNotice', async () => {
  const { compareVersions, updateNotice } = await import('../src/heartbeat.js');
  const visitor = { debug: false, environment: 'production', runtime: 'browser' as const };

  it('compares dotted versions numerically', () => {
    expect(compareVersions('0.8.9', '0.8.13')).toBe(-1);
    expect(compareVersions('0.9.0', '0.8.13')).toBe(1);
    expect(compareVersions('0.8.13', '0.8.13')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(0);
  });

  it('keeps a production page in a visitor browser quiet unless debug is on', () => {
    vi.stubGlobal('location', { hostname: 'app.example.com' });
    const answer = { latest_sdk: '9.0.0' };
    expect(updateNotice('0.8.13', answer, visitor)).toBeNull();
    expect(updateNotice('0.8.13', answer, { ...visitor, debug: true })).toContain('9.0.0');
    expect(updateNotice('0.8.13', answer, { ...visitor, environment: 'staging' })).toContain(
      '9.0.0',
    );
    vi.stubGlobal('location', { hostname: 'localhost' });
    expect(updateNotice('0.8.13', answer, visitor)).toContain('9.0.0');
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('ignores an answer without a version', () => {
    expect(updateNotice('0.8.13', null, { ...visitor, debug: true })).toBeNull();
    expect(updateNotice('0.8.13', { accepted: 1 }, { ...visitor, debug: true })).toBeNull();
  });
});
