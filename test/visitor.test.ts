import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgosClient } from '../src/client.js';
import { forgetPages, pageKey } from '../src/pageviews.js';
import { Identity } from '../src/session.js';
import { createStore, memoryStore } from '../src/storage.js';
import type { ArgosEvent, EventBatch } from '../src/types.js';

const DSN = 'https://a1b2c3@ingest.argos.dev/42';

let fetchMock: ReturnType<typeof vi.fn>;

function pageviews(): ArgosEvent[] {
  return fetchMock.mock.calls
    .filter((call) => (call[0] as string).includes('/events/'))
    .flatMap((call) => (JSON.parse((call[1] as RequestInit).body as string) as EventBatch).events)
    .filter((event) => event.name === 'pageview');
}

async function view(options: ConstructorParameters<typeof ArgosClient>[0]): Promise<ArgosEvent> {
  forgetPages();
  fetchMock.mockClear();
  const client = new ArgosClient(options);
  client.pageview('/a');
  await client.flush();
  client.close();
  return pageviews()[0];
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetPages();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.history.replaceState({}, '', '/');
});

describe('visitor_id', () => {
  it('is a random id within the 64 char contract, stored in localStorage', async () => {
    const event = await view({ dsn: DSN });
    const id = event.props?.visitor_id as string;
    expect(id.length).toBeLessThanOrEqual(64);
    expect(localStorage.getItem('argos.visitor_id')).toBe(id);
    expect(id).not.toBe(localStorage.getItem('argos.anon_id'));
  });

  it('is kept for a returning visitor, across clients and sessions', async () => {
    const first = await view({ dsn: DSN });
    sessionStorage.clear();
    localStorage.removeItem('argos.session_id');
    const second = await view({ dsn: DSN });
    expect(first.session_id).not.toBe(second.session_id);
    expect(second.props?.visitor_id).toBe(first.props?.visitor_id);
  });

  it('is neither created nor sent before consent', async () => {
    const event = await view({ dsn: DSN, requireConsent: true });
    expect(event).toBeUndefined();
    expect(localStorage.getItem('argos.visitor_id')).toBeNull();
  });

  it('is neither created nor sent once consent is denied', async () => {
    localStorage.setItem('argos.consent', 'denied');
    const event = await view({ dsn: DSN });
    expect(event).toBeUndefined();
    expect(localStorage.getItem('argos.visitor_id')).toBeNull();
  });

  it('is sent after consent is granted', async () => {
    localStorage.setItem('argos.consent', 'granted');
    const event = await view({ dsn: DSN, requireConsent: true });
    expect(event.props?.visitor_id).toBeTypeOf('string');
  });

  it('is omitted, not minted per page, when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    });
    const event = await view({ dsn: DSN });
    expect(event.props).not.toHaveProperty('visitor_id');
    expect(new Identity(createStore('localStorage'), memoryStore()).visitorId()).toBeUndefined();
  });

  it('is off with trackVisitor: false', async () => {
    const event = await view({ dsn: DSN, trackVisitor: false });
    expect(event.props).not.toHaveProperty('visitor_id');
    expect(localStorage.getItem('argos.visitor_id')).toBeNull();
  });
});

describe('ref', () => {
  it('is captured trimmed and capped, while the page key still ignores it', async () => {
    globalThis.history.replaceState({}, '', `/?ref=%20${'x'.repeat(300)}%20`);
    const event = await view({ dsn: DSN });
    expect(event.props?.ref).toBe('x'.repeat(200));
    expect(pageKey({ pathname: '/p', search: '?ref=abc', hash: '' })).toBe('/p');
  });

  it('is absent when the URL has none or a blank one', async () => {
    globalThis.history.replaceState({}, '', '/?ref=%20');
    const event = await view({ dsn: DSN });
    expect(event.props).not.toHaveProperty('ref');
  });
});
