import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initServer, parseBaggage, spineFrom } from '../src/server/index.js';

const DSN = 'https://0123456789abcdef0123456789abcdef@ingest.example.com/42';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
const SESSION = '0192f3a7-1c2e-7c31-9a1e-6f0b8c2d4e5a';
const ANON = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function headers(extra: Record<string, string> = {}) {
  return {
    traceparent: `00-${TRACE}-${SPAN}-01`,
    baggage: `argos.session_id=${SESSION},argos.anon_id=${ANON}`,
    ...extra,
  };
}

describe('lifting the visit off a request', () => {
  it('reads the spine the browser attached', () => {
    const spine = spineFrom(headers());

    expect(spine).toEqual({ traceId: TRACE, parentSpanId: SPAN, sessionId: SESSION, anonId: ANON });
  });

  it('carries the person and the tenant when they were set', () => {
    const spine = spineFrom(
      headers({
        baggage: `argos.session_id=${SESSION},argos.anon_id=${ANON},argos.user_id=user_1,argos.account_id=acct_7f3a`,
      }),
    );

    expect(spine?.userId).toBe('user_1');
    expect(spine?.accountId).toBe('acct_7f3a');
  });

  it('refuses a request that is not a visit', () => {
    // A cron, a webhook, a curl. Handing these a made-up session id would put
    // a nightly job in the visitor count.
    expect(spineFrom({})).toBeUndefined();
    expect(spineFrom({ traceparent: `00-${TRACE}-${SPAN}-01` })).toBeUndefined();
    expect(spineFrom(headers({ traceparent: 'garbage' }))).toBeUndefined();
  });

  it('refuses half a spine rather than sending one the database will reject', () => {
    const spine = spineFrom(headers({ baggage: `argos.session_id=${SESSION}` }));

    expect(spine).toBeUndefined();
  });

  it('reads a Headers object as happily as a plain node bag', () => {
    const web = new Headers(headers());

    expect(spineFrom(web)?.sessionId).toBe(SESSION);
  });

  it('survives the whitespace and metadata real proxies add', () => {
    const bag = parseBaggage(' argos.session_id = abc ;meta=1 , argos.anon_id=def ');

    expect(bag['argos.session_id']).toBe('abc');
    expect(bag['argos.anon_id']).toBe('def');
  });

  it('skips an entry that is not valid percent-encoding instead of throwing', () => {
    // Somebody else's baggage on a shared header. A request handler must not
    // die because a third party wrote something odd.
    expect(() => parseBaggage('broken=%E0%A4%A,argos.anon_id=fine')).not.toThrow();
    expect(parseBaggage('broken=%E0%A4%A,argos.anon_id=fine')['argos.anon_id']).toBe('fine');
  });
});

describe('an event that happened where no browser was looking', () => {
  let bodies: string[] = [];

  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: { body?: string }) => {
        if (options.body) bodies.push(options.body);
        return Promise.resolve(new Response(null, { status: 202 }));
      }),
    );
  });

  it('lands on the session that asked for it', async () => {
    const argos = initServer({ dsn: DSN });

    const visit = argos.visit(
      headers({
        baggage: `argos.session_id=${SESSION},argos.anon_id=${ANON},argos.account_id=acct_7f3a`,
      }),
    );
    visit?.track('invoice_paid', { amount_cents: 4200 });
    await argos.flush();

    const batch: unknown = JSON.parse(bodies[0] ?? '{}');
    const events = (batch as { events?: Record<string, unknown>[] }).events ?? [];
    const event = events[0] ?? {};
    expect(event['session_id']).toBe(SESSION);
    expect(event['trace_id']).toBe(TRACE);
    expect(event['account_id']).toBe('acct_7f3a');
    expect(event['platform']).toBe('server');
    // Its own span: this work is not the browser's operation.
    expect(event['span_id']).not.toBe(SPAN);
  });

  it('sends nothing for a request with no visit behind it', async () => {
    const argos = initServer({ dsn: DSN });

    expect(argos.visit({})).toBeUndefined();
    await argos.flush();

    expect(bodies).toEqual([]);
  });

  it('reports whether the batch left, so a caller that cares can retry', async () => {
    const argos = initServer({ dsn: DSN });
    argos.visit(headers())?.track('invoice_paid');

    expect(await argos.flush()).toBe(true);
    // Emptied by the flush: a second call has nothing to send and says so.
    expect(await argos.flush()).toBe(true);
    expect(bodies).toHaveLength(1);
  });
});
