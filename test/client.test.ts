import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgosClient } from '../src/client.js';
import { close, flush, init, pageview, track, traceHeaders } from '../src/index.js';
import type { ArgosEvent, EventBatch, IdentifyPayload } from '../src/types.js';

const DSN = 'https://a1b2c3@ingest.argos.dev/42';

let fetchMock: ReturnType<typeof vi.fn>;

function sentEvents(): ArgosEvent[] {
  return fetchMock.mock.calls.flatMap((call) => {
    const init = call[1] as RequestInit;
    const url = call[0] as string;
    if (!url.includes('/events/')) return [];
    return (JSON.parse(init.body as string) as EventBatch).events;
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  close();
  vi.unstubAllGlobals();
});

describe('the event shape', () => {
  it('carries every field the wire contract requires', async () => {
    const client = new ArgosClient({ dsn: DSN, release: 'web@2026.8.1', environment: 'staging' });
    client.track('checkout_started', { plan: 'pro' });
    await client.flush();
    client.close();

    const event = sentEvents()[0];
    expect(event).toMatchObject({
      kind: 'product',
      name: 'checkout_started',
      platform: 'browser',
      environment: 'staging',
      release: 'web@2026.8.1',
      props: { plan: 'pro' },
    });
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.event_time).toMatch(/Z$/);
    expect(event.session_id[14]).toBe('7');
    expect(event.anon_id[14]).toBe('4');
    expect(event.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(event.user_id).toBeUndefined();
  });

  it('defaults the environment to production', async () => {
    const client = new ArgosClient({ dsn: DSN });
    client.track('click');
    await client.flush();
    client.close();
    expect(sentEvents()[0]?.environment).toBe('production');
  });

  it('truncates a name past the 200 character limit', async () => {
    const client = new ArgosClient({ dsn: DSN });
    client.track('x'.repeat(500));
    await client.flush();
    client.close();
    expect(sentEvents()[0]?.name).toHaveLength(200);
  });

  it('gives each event its own trace but keeps one session', async () => {
    const client = new ArgosClient({ dsn: DSN });
    client.track('a');
    client.track('b');
    await client.flush();
    client.close();
    const [first, second] = sentEvents();
    expect(first.trace_id).not.toBe(second.trace_id);
    expect(first.session_id).toBe(second.session_id);
  });
});

describe('identify', () => {
  it('posts the alias and stamps user_id on later events only', async () => {
    const client = new ArgosClient({ dsn: DSN });
    client.track('before');
    client.identify('user_8871');
    client.track('after');
    await client.flush();
    client.close();

    const identifyCall = fetchMock.mock.calls.find((call) =>
      (call[0] as string).includes('/identify/'),
    );
    expect(identifyCall?.[0]).toBe('https://ingest.argos.dev/api/42/identify/');
    const payload = JSON.parse(
      (identifyCall?.[1] as RequestInit).body as string,
    ) as IdentifyPayload;
    expect(payload.user_id).toBe('user_8871');
    expect(payload.anon_id).toMatch(/^[0-9a-f-]{36}$/);

    const events = sentEvents();
    expect(events.find((e) => e.name === 'before')?.user_id).toBeUndefined();
    expect(events.find((e) => e.name === 'after')?.user_id).toBe('user_8871');
  });
});

describe('pageview', () => {
  it('uses the current path when none is given', async () => {
    const client = new ArgosClient({ dsn: DSN });
    client.pageview();
    await client.flush();
    client.close();
    expect(sentEvents()[0]?.props).toMatchObject({ path: globalThis.location.pathname });
  });

  it('takes an explicit path, for routers that report their own', async () => {
    const client = new ArgosClient({ dsn: DSN });
    client.pageview('/checkout');
    await client.flush();
    client.close();
    expect(sentEvents()[0]).toMatchObject({ name: 'pageview', props: { path: '/checkout' } });
  });
});

describe('lifecycle flushes', () => {
  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
  }

  afterEach(() => {
    setVisibility('visible');
  });

  it('beacons the buffer when the page goes hidden', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const client = new ArgosClient({ dsn: DSN });
    client.track('click');
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('ignores a visibilitychange back to visible', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const client = new ArgosClient({ dsn: DSN });
    client.track('click');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).not.toHaveBeenCalled();
    client.close();
  });

  it('beacons the buffer on pagehide', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const client = new ArgosClient({ dsn: DSN });
    client.track('click');
    globalThis.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('detaches the listeners on close', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const client = new ArgosClient({ dsn: DSN });
    client.track('click');
    client.close();
    globalThis.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

describe('traceHeaders', () => {
  it('matches the propagation example in the wire contract', () => {
    const client = new ArgosClient({ dsn: DSN });
    const headers = client.traceHeaders();
    client.close();
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers.baggage).toMatch(
      /^argos\.session_id=[0-9a-f-]{36},argos\.anon_id=[0-9a-f-]{36}$/,
    );
  });
});

describe('the module-level api', () => {
  it('no-ops before init instead of throwing at the host app', async () => {
    expect(() => {
      track('click');
      pageview('/');
    }).not.toThrow();
    expect(traceHeaders()).toBeUndefined();
    await expect(flush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes through the client after init', async () => {
    init({ dsn: DSN });
    track('click');
    await flush();
    expect(sentEvents()).toHaveLength(1);
  });

  it('closes the previous client when init runs twice', async () => {
    const first = init({ dsn: DSN });
    const second = init({ dsn: DSN });
    expect(second).not.toBe(first);
    track('click');
    await flush();
    expect(sentEvents()).toHaveLength(1);
  });
});

describe('automatic capture', () => {
  const originalPushState = globalThis.history.pushState;

  afterEach(() => {
    globalThis.history.pushState = originalPushState;
    originalPushState.call(globalThis.history, {}, '', '/');
  });

  it('stays quiet unless the options ask for it', async () => {
    const client = new ArgosClient({ dsn: DSN });
    globalThis.history.pushState({}, '', '/pricing');
    await client.flush();
    client.close();
    expect(sentEvents()).toHaveLength(0);
  });

  it('emits contract-shaped pageviews on load and on SPA navigation', async () => {
    const client = new ArgosClient({ dsn: DSN, autoPageviews: true });
    globalThis.history.pushState({}, '', '/pricing?utm_source=x');
    await client.flush();
    client.close();

    const events = sentEvents();
    expect(events.map((event) => event.name)).toEqual(['pageview', 'pageview']);
    expect(events[1].props).toMatchObject({ path: '/pricing', previous_path: '/' });
    expect(events[0].session_id).toBe(events[1].session_id);
  });

  it('takes pageview options through the same flag', async () => {
    const client = new ArgosClient({ dsn: DSN, autoPageviews: { hashMode: true } });
    globalThis.history.pushState({}, '', '/#/orders');
    await client.flush();
    client.close();
    expect(sentEvents()[1].props).toMatchObject({ path: '/#/orders' });
  });

  it('unpatches history on close', () => {
    const client = new ArgosClient({ dsn: DSN, autoPageviews: true });
    expect(globalThis.history.pushState).not.toBe(originalPushState);
    client.close();
    expect(globalThis.history.pushState).toBe(originalPushState);
  });

  it('batches the vitals into the unload flush', async () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const observers: ((entries: unknown[]) => void)[] = [];
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        constructor(private readonly handler: (list: { getEntries: () => unknown[] }) => void) {}
        observe(init: { type: string }): void {
          if (init.type !== 'paint') return;
          observers.push((entries) => {
            this.handler({ getEntries: () => entries });
          });
        }
        disconnect(): void {}
      },
    );

    const client = new ArgosClient({ dsn: DSN, webVitals: true });
    for (const deliver of observers) {
      deliver([{ name: 'first-contentful-paint', startTime: 1234 }]);
    }
    globalThis.dispatchEvent(new Event('pagehide'));
    client.close();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [, blob] = sendBeacon.mock.calls[0] as [string, Blob];
    const batch = JSON.parse(await blob.text()) as EventBatch;
    expect(batch.events.map((event) => event.name)).toEqual(['web_vital', 'web_vital']);
    expect(batch.events.map((event) => event.props?.metric)).toEqual(['CLS', 'FCP']);
    expect(batch.events[1]).toMatchObject({
      props: { metric: 'FCP', value: 1234, rating: 'good', path: '/' },
    });
  });
});

describe('correlation', () => {
  it('hands out the keys a foreign SDK needs to join this visit', () => {
    const client = init({ dsn: DSN });
    const keys = client.correlation();

    // The tag names ingest reads, so the object drops onto a Sentry event as-is.
    expect(Object.keys(keys).sort()).toEqual(['argos_anon_id', 'argos_session_id']);
    expect(keys.argos_session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys.argos_anon_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports the same session the events are carrying', async () => {
    const client = init({ dsn: DSN });
    const keys = client.correlation();

    client.track('anything');
    await client.flush();

    // A value that disagreed with the events would tie a Sentry error to a
    // visit that does not exist, which is worse than not tying it at all.
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body ?? '{}'));
    expect(body.events[0].session_id).toBe(keys.argos_session_id);
    expect(body.events[0].anon_id).toBe(keys.argos_anon_id);
  });
});
