import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgosClient } from '../src/client.js';
import { instrumentFetch, isAllowedOrigin } from '../src/instrument.js';

const DSN = 'https://a1b2c3@ingest.argos.dev/42';
const SAME_ORIGIN = `${globalThis.location.origin}/api/orders`;
const THIRD_PARTY = 'https://analytics.example.com/collect';

let client: ArgosClient;
let original: ReturnType<typeof vi.fn>;
let undo: () => void = () => undefined;

beforeEach(() => {
  undo = () => undefined;
  localStorage.clear();
  sessionStorage.clear();
  original = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', original);
  client = new ArgosClient({ dsn: DSN });
});

afterEach(() => {
  undo();
  client.close();
  vi.unstubAllGlobals();
});

function headersOf(call: number): Headers {
  return (original.mock.calls[call][0] as Request).headers;
}

describe('isAllowedOrigin', () => {
  it('accepts same-origin by default', () => {
    expect(isAllowedOrigin('/api/orders')).toBe(true);
    expect(isAllowedOrigin(SAME_ORIGIN)).toBe(true);
  });

  it('rejects a third party by default', () => {
    expect(isAllowedOrigin(THIRD_PARTY)).toBe(false);
  });

  it('accepts an explicitly allowlisted origin', () => {
    expect(isAllowedOrigin('https://api.argos.dev/v1', ['https://api.argos.dev'])).toBe(true);
  });

  it('matches on origin, not on a url prefix', () => {
    expect(
      isAllowedOrigin('https://evil.dev/?x=https://api.argos.dev', ['https://api.argos.dev']),
    ).toBe(false);
  });

  it('supports a regex for wildcard subdomains', () => {
    const origins = [/^https:\/\/[a-z-]+\.argos\.dev$/];
    expect(isAllowedOrigin('https://api.argos.dev/v1', origins)).toBe(true);
    expect(isAllowedOrigin('https://api.other.dev/v1', origins)).toBe(false);
  });

  it('rejects an unparseable url', () => {
    expect(isAllowedOrigin('http://', ['https://api.argos.dev'])).toBe(false);
  });

  it('drops same-origin when an allowlist is given and does not include it', () => {
    expect(isAllowedOrigin(SAME_ORIGIN, ['https://api.argos.dev'])).toBe(false);
  });
});

describe('instrumentFetch', () => {
  it('attaches traceparent and baggage to a same-origin request', async () => {
    undo = instrumentFetch(client);
    await fetch(SAME_ORIGIN);
    const headers = headersOf(0);
    expect(headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers.get('baggage')).toContain('argos.session_id=');
  });

  it('leaves a third-party request untouched', async () => {
    undo = instrumentFetch(client);
    await fetch(THIRD_PARTY);
    expect(original.mock.calls[0][0]).toBe(THIRD_PARTY);
  });

  it('attaches to an allowlisted third party', async () => {
    undo = instrumentFetch(client, { origins: ['https://analytics.example.com'] });
    await fetch(THIRD_PARTY);
    expect(headersOf(0).get('traceparent')).toBeTruthy();
  });

  it('handles a Request object and a URL, not just a string', async () => {
    undo = instrumentFetch(client);
    await fetch(new Request(SAME_ORIGIN, { method: 'POST', body: 'x' }));
    await fetch(new URL(SAME_ORIGIN));
    expect(headersOf(0).get('traceparent')).toBeTruthy();
    expect((original.mock.calls[0][0] as Request).method).toBe('POST');
    expect(headersOf(1).get('traceparent')).toBeTruthy();
  });

  it('never overwrites a traceparent the caller set', async () => {
    undo = instrumentFetch(client);
    const upstream = '00-11111111111111111111111111111111-2222222222222222-01';
    await fetch(SAME_ORIGIN, { headers: { traceparent: upstream } });
    expect(headersOf(0).get('traceparent')).toBe(upstream);
  });

  it('keeps the request headers the caller passed', async () => {
    undo = instrumentFetch(client);
    await fetch(SAME_ORIGIN, { headers: { 'X-Custom': 'kept' } });
    expect(headersOf(0).get('x-custom')).toBe('kept');
  });

  it('restores the original fetch on undo', async () => {
    const restore = instrumentFetch(client);
    const wrapped = globalThis.fetch;
    restore();
    expect(globalThis.fetch).toBe(original);
    expect(wrapped).not.toBe(original);
    undo = () => undefined;
    await Promise.resolve();
  });

  it('reuses one session across many outbound requests', async () => {
    undo = instrumentFetch(client);
    await fetch(SAME_ORIGIN);
    await fetch(SAME_ORIGIN);
    expect(headersOf(0).get('baggage')).toBe(headersOf(1).get('baggage'));
  });

  it('merges into a baggage header another tracer already wrote', async () => {
    undo = instrumentFetch(client);
    const foreign = 'sentry-trace_id=abc,sentry-environment=prod';
    await fetch(SAME_ORIGIN, { headers: { baggage: foreign } });
    const merged = headersOf(0).get('baggage') ?? '';
    expect(merged).toContain('sentry-trace_id=abc');
    expect(merged).toContain('sentry-environment=prod');
    expect(merged).toContain('argos.session_id=');
    expect(merged).toContain('argos.anon_id=');
  });

  it('replaces stale argos entries instead of duplicating keys', async () => {
    undo = instrumentFetch(client);
    await fetch(SAME_ORIGIN, {
      headers: { baggage: 'argos.session_id=stale,other=1,other=2,argos.user_id=gone' },
    });
    const keys = (headersOf(0).get('baggage') ?? '').split(',').map((m) => m.split('=')[0]);
    expect(keys.filter((k) => k === 'argos.session_id')).toHaveLength(1);
    expect(keys.filter((k) => k === 'other')).toHaveLength(1);
    expect(keys).not.toContain('argos.user_id');
    expect(headersOf(0).get('baggage')).not.toContain('stale');
  });

  it('stays within the W3C baggage limits, keeping its own entries', async () => {
    undo = instrumentFetch(client);
    const crowd = Array.from({ length: 80 }, (_, i) => `k${String(i)}=${'v'.repeat(150)}`);
    await fetch(SAME_ORIGIN, { headers: { baggage: crowd.join(',') } });
    const merged = headersOf(0).get('baggage') ?? '';
    expect(merged.split(',').length).toBeLessThanOrEqual(64);
    expect(merged.length).toBeLessThanOrEqual(8192);
    expect(merged).toContain('argos.session_id=');
  });
});
