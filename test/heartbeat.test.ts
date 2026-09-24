import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(beats().at(-1)?.body.environment).toBe('staging');
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
    expect(beats().at(-1)?.body).toEqual({
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
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const { init } = await browser();

    expect(init({ dsn: DSN })).toBeDefined();
    await tick();
    expect(beats()).toHaveLength(1);
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

    // The last one: ours is scheduled after anything a previous test left pending.
    expect(beats().at(-1)?.body.sentry).toEqual({
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

    expect(beats().at(-1)?.body.sentry).toEqual({ name: 'sentry', version: '9.1.0' });
  });
});
