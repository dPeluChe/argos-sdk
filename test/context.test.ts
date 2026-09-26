import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgosClient } from '../src/client.js';
import { browserProps, campaignProps } from '../src/context.js';
import { pageKey } from '../src/pageviews.js';
import type { ArgosEvent, EventBatch } from '../src/types.js';

const DSN = 'https://a1b2c3@ingest.argos.dev/42';
const CAMPAIGN =
  '?utm_source=newsletter&utm_medium=email&utm_campaign=spring&utm_content=hero&utm_term=running%20shoes';

function search(url: string): string {
  return new URL(url, 'https://shop.example.com').search;
}

describe('campaignProps', () => {
  it('reads the five campaign parameters from a real URL', () => {
    expect(campaignProps(search(`/checkout${CAMPAIGN}`))).toEqual({
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'spring',
      utm_content: 'hero',
      utm_term: 'running shoes',
    });
  });

  it('reports absence as absence, never as an empty string', () => {
    expect(campaignProps(search('/'))).toEqual({});
    expect(campaignProps(search('/?utm_source=&utm_medium=%20&utm_campaign=ads'))).toEqual({
      utm_campaign: 'ads',
    });
  });

  it('ignores parameters that only look like campaign tags', () => {
    expect(campaignProps(search('/?utm=x&utm_sourced=y&page=2'))).toEqual({});
  });

  it('trims and caps a value at 200 characters', () => {
    const props = campaignProps(search(`/?utm_source=%20${'x'.repeat(500)}%20`));
    expect(props.utm_source).toBe('x'.repeat(200));
  });

  it('reports the ad network of a click id, never the click id itself', () => {
    const props = campaignProps(search('/?gclid=EAIaIQobChMI-secret'));
    expect(props).toEqual({ click_id_source: 'gclid' });
    expect(JSON.stringify(props)).not.toContain('secret');
  });

  it('reports a click id alongside the campaign tags it arrived with', () => {
    expect(campaignProps(search('/?utm_source=meta&fbclid=abc'))).toEqual({
      utm_source: 'meta',
      click_id_source: 'fbclid',
    });
  });

  it('leaves click_id_source out for the trackers that are not ad clicks', () => {
    expect(campaignProps(search('/?_ga=1.2.3&ref=blog&igshid=xyz&mc_cid=1'))).toEqual({});
  });
});

describe('browserProps', () => {
  it('reports the screen, the viewport, the language and the time zone', () => {
    expect(browserProps()).toEqual({
      screen_width: globalThis.screen.width,
      screen_height: globalThis.screen.height,
      viewport_width: globalThis.innerWidth,
      viewport_height: globalThis.innerHeight,
      language: globalThis.navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('drops what the browser does not expose instead of guessing', () => {
    vi.stubGlobal('screen', undefined);
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('innerWidth', undefined);
    vi.stubGlobal('innerHeight', undefined);
    vi.stubGlobal('Intl', undefined);
    expect(browserProps()).toEqual({});
    vi.unstubAllGlobals();
  });

  it('still reports the rest when Intl throws', () => {
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => {
        throw new RangeError('no ICU');
      },
    });
    const props = browserProps();
    expect(props.timezone).toBeUndefined();
    expect(props.language).toBe(globalThis.navigator.language);
    vi.unstubAllGlobals();
  });
});

describe('the page identity is untouched by attribution', () => {
  it('still strips every parameter the pageview reports', () => {
    const location = { pathname: '/checkout', search: `${CAMPAIGN}&gclid=abc&page=2`, hash: '' };
    expect(pageKey(location)).toBe('/checkout?page=2');
  });
});

describe('attribution on the wire', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalReplaceState = globalThis.history.replaceState;

  function sentEvents(): ArgosEvent[] {
    return fetchMock.mock.calls.flatMap((call) => {
      const url = call[0] as string;
      if (!url.includes('/events/')) return [];
      return (JSON.parse((call[1] as RequestInit).body as string) as EventBatch).events;
    });
  }

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    originalReplaceState.call(globalThis.history, {}, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    originalReplaceState.call(globalThis.history, {}, '', '/');
  });

  it('sends the campaign of the entry, then none on a pageview without one', async () => {
    originalReplaceState.call(globalThis.history, {}, '', `/landing${CAMPAIGN}`);
    const client = new ArgosClient({ dsn: DSN, autoPageviews: true });
    globalThis.history.pushState({}, '', '/pricing');
    await client.flush();
    client.close();

    const [entry, second] = sentEvents();
    expect(entry.props).toMatchObject({ path: '/landing', utm_source: 'newsletter' });
    expect(second.props).toMatchObject({ path: '/pricing' });
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      expect(second.props?.[key]).toBeUndefined();
    }
  });

  it('reports a campaign arriving mid-visit, and lets the server keep the first', async () => {
    const client = new ArgosClient({ dsn: DSN, autoPageviews: true });
    globalThis.history.pushState({}, '', '/pricing?utm_source=twitter');
    await client.flush();
    client.close();

    const [entry, second] = sentEvents();
    expect(entry.props?.utm_source).toBeUndefined();
    expect(second.props).toMatchObject({ path: '/pricing', utm_source: 'twitter' });
  });

  it('sends the browser context once per visit, not once per pageview', async () => {
    const client = new ArgosClient({ dsn: DSN, autoPageviews: true });
    globalThis.history.pushState({}, '', '/pricing');
    await client.flush();
    client.close();

    const [entry, second] = sentEvents();
    expect(entry.props).toMatchObject({ language: globalThis.navigator.language });
    expect(entry.props?.screen_width).toBe(globalThis.screen.width);
    expect(entry.props?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(second.props?.language).toBeUndefined();
    expect(second.props?.screen_width).toBeUndefined();
    expect(second.props?.timezone).toBeUndefined();

    // A second page load of the same visit is not a second entry.
    const next = new ArgosClient({ dsn: DSN, autoPageviews: true });
    next.pageview('/cart');
    await next.flush();
    next.close();
    expect(sentEvents().at(-1)?.props?.screen_width).toBeUndefined();
    expect(sentEvents().at(-1)?.props?.timezone).toBeUndefined();
  });

  it('sends the entry referrer once, never on the SPA navigations after it', async () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://news.example.com/post',
    });
    const client = new ArgosClient({ dsn: DSN, autoPageviews: true });
    globalThis.history.pushState({}, '', '/pricing');
    await client.flush();
    client.close();

    const [entry, second] = sentEvents();
    expect(entry.props?.referrer).toBe('https://news.example.com/post');
    expect(second.props?.referrer).toBeUndefined();
    expect(second.props?.previous_path).toBe('/');
  });

  it('emits a pageview with no attribution at all when there is no location', async () => {
    const client = new ArgosClient({ dsn: DSN });
    vi.stubGlobal('location', undefined);
    expect(() => {
      client.pageview();
    }).not.toThrow();
    await client.flush();
    client.close();

    expect(sentEvents()[0]?.props).toMatchObject({ path: '/' });
    expect(sentEvents()[0]?.props?.utm_source).toBeUndefined();
  });
});
