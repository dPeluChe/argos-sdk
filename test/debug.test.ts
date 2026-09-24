import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgosClient } from '../src/client.js';
import { close, flush, grantConsent, identify, init, revokeConsent, track } from '../src/index.js';
import { initServer } from '../src/server/index.js';

const DSN = 'https://a1b2c3@ingest.argos.dev/42';

let fetchMock: ReturnType<typeof vi.fn>;
let info: ReturnType<typeof vi.spyOn>;

function lines(): string[] {
  return info.mock.calls.map((call) => String(call[0]));
}

function has(fragment: string): boolean {
  return lines().some((line) => line.includes(fragment));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('debug off', () => {
  it('writes nothing to the console, whatever happens', async () => {
    const spies = (['log', 'debug', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    fetchMock.mockResolvedValue(new Response('{"error":"bad key"}', { status: 401 }));
    init({ dsn: DSN, requireConsent: true });
    track('before_consent');
    grantConsent();
    track('checkout');
    identify('user-1');
    await flush();
    revokeConsent();
    track('after_revoke');

    expect(info).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('debug on', () => {
  it('reports what init resolved', () => {
    init({ dsn: DSN, debug: true });

    const line = lines()[0] ?? '';
    expect(line.startsWith('[argos] ')).toBe(true);
    expect(line).toContain('ingest.argos.dev');
    expect(line).toContain('project 42');
    expect(line).toContain('consent unknown');
    expect(line).toMatch(/session [0-9a-f-]{36}/);
  });

  it('does not create a session to report one before consent', () => {
    init({ dsn: DSN, debug: true, requireConsent: true });

    expect(has('session none')).toBe(true);
    expect(sessionStorage.length).toBe(0);
  });

  it('reports every queued event and every drop, with the reason', () => {
    init({ dsn: DSN, debug: true, requireConsent: true });
    track('too_early');
    grantConsent();
    track('checkout');
    revokeConsent();
    track('too_late');

    expect(has('drop too_early: consent pending')).toBe(true);
    expect(has('queue product checkout')).toBe(true);
    expect(has('drop too_late: consent denied')).toBe(true);
  });

  it('reports a flush, its transport and the ingest status', async () => {
    init({ dsn: DSN, debug: true });
    track('a');
    track('b');
    await flush();

    expect(has('flush 2 via fetch')).toBe(true);
    expect(has('ingest 202')).toBe(true);
  });

  it('quotes the ingest error body on a 4xx', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unknown public key"}', { status: 401 }));
    init({ dsn: DSN, debug: true });
    track('a');
    await flush();

    expect(has('ingest 401 {"error":"unknown public key"}')).toBe(true);
  });

  it('reports a retry', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    init({ dsn: DSN, debug: true });
    track('a');
    await flush();

    expect(has('ingest 503')).toBe(true);
    expect(lines().some((line) => /retry 1 in \d+ms/.test(line))).toBe(true);
  });

  it('reports the beacon on page hide', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(true) });
    init({ dsn: DSN, debug: true });
    track('a');
    globalThis.dispatchEvent(new Event('pagehide'));

    expect(has('flush 1 via beacon')).toBe(true);
  });

  it('reports what the outbox holds back and resends', () => {
    vi.stubGlobal('navigator', {});
    const first = new ArgosClient({ dsn: DSN, debug: true });
    first.track('a');
    globalThis.dispatchEvent(new Event('pagehide'));
    first.close();
    expect(has('outbox kept 1')).toBe(true);

    const second = new ArgosClient({ dsn: DSN, debug: true });
    expect(has('outbox resend 1')).toBe(true);
    second.close();
  });
});

describe('server debug', () => {
  const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const SESSION = '0192f3a7-1c2e-7c31-9a1e-6f0b8c2d4e5a';
  const BAGGAGE = `argos.session_id=${SESSION},argos.anon_id=3f2504e0-4f89-11d3-9a0c-0305e82c3301`;

  it('reports a visit found, one not found, and the flush result', async () => {
    const argos = initServer({ dsn: DSN, debug: true });
    argos.visit({ traceparent: TRACEPARENT, baggage: BAGGAGE })?.track('order_placed');
    argos.visit({});
    await argos.flush();

    expect(has(`visit ${SESSION}`)).toBe(true);
    expect(has('no visit')).toBe(true);
    expect(has('flush 1: delivered')).toBe(true);
  });

  it('is silent without debug', async () => {
    const argos = initServer({ dsn: DSN });
    argos.visit({ traceparent: TRACEPARENT, baggage: BAGGAGE })?.track('order_placed');
    argos.visit({});
    await argos.flush();

    expect(info).not.toHaveBeenCalled();
  });
});
