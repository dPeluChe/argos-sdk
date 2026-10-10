import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageKey, PageviewTracker } from '../src/pageviews.js';
import type { Props } from '../src/types.js';

const originalPushState = globalThis.history.pushState;
const originalReplaceState = globalThis.history.replaceState;

function newTracker(options?: ConstructorParameters<typeof PageviewTracker>[1]): {
  tracker: PageviewTracker;
  emitted: Props[];
} {
  const emitted: Props[] = [];
  const tracker = new PageviewTracker((props) => emitted.push(props), options);
  return { tracker, emitted };
}

describe('pageKey', () => {
  const key = (search: string, hash = '', options = {}): string =>
    pageKey({ pathname: '/checkout', search, hash }, options);

  it('keeps the parameters that select content, sorted', () => {
    expect(key('?b=2&a=1')).toBe('/checkout?a=1&b=2');
    expect(key('?a=1&b=2')).toBe(key('?b=2&a=1'));
  });

  it('drops campaign and click-id parameters', () => {
    expect(key('?utm_source=x&gclid=y&fbclid=z')).toBe('/checkout');
    expect(key('?page=2&utm_medium=email')).toBe('/checkout?page=2');
  });

  it('ignores the hash unless hashMode is on', () => {
    expect(key('', '#/orders')).toBe('/checkout');
    expect(key('', '#/orders', { hashMode: true })).toBe('/checkout#/orders');
  });

  it('replaces the built-in ignore list but never the utm_ prefix', () => {
    expect(key('?ref=a&mine=b&utm_id=c', '', { ignoreParams: ['mine'] })).toBe('/checkout?ref=a');
  });
});

describe('PageviewTracker', () => {
  beforeEach(() => {
    originalReplaceState.call(globalThis.history, {}, '', '/');
  });

  afterEach(() => {
    globalThis.history.pushState = originalPushState;
    globalThis.history.replaceState = originalReplaceState;
  });

  it('emits on start with the path, title and no previous path', () => {
    document.title = 'Home';
    const { tracker, emitted } = newTracker();
    tracker.start();
    expect(emitted).toEqual([{ path: '/', title: 'Home' }]);
    tracker.stop();
  });

  it('emits exactly one pageview per pushState', () => {
    const { tracker, emitted } = newTracker();
    tracker.start();
    globalThis.history.pushState({}, '', '/pricing');
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ path: '/pricing', previous_path: '/' });
    tracker.stop();
  });

  it('emits exactly one pageview per replaceState', () => {
    const { tracker, emitted } = newTracker();
    tracker.start();
    globalThis.history.replaceState({}, '', '/docs');
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ path: '/docs', previous_path: '/' });
    tracker.stop();
  });

  it('emits exactly one pageview per popstate', () => {
    const { tracker, emitted } = newTracker();
    tracker.start();
    originalReplaceState.call(globalThis.history, {}, '', '/back');
    globalThis.dispatchEvent(new Event('popstate'));
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ path: '/back' });
    tracker.stop();
  });

  it('never fires twice for the same path in a row', () => {
    const { tracker, emitted } = newTracker();
    tracker.start();
    globalThis.history.pushState({}, '', '/pricing');
    globalThis.history.pushState({}, '', '/pricing');
    globalThis.history.replaceState({}, '', '/pricing');
    globalThis.dispatchEvent(new Event('popstate'));
    expect(emitted.map((props) => props.path)).toEqual(['/', '/pricing']);
    tracker.stop();
  });

  it('treats a campaign-only query change as the same page', () => {
    const { tracker, emitted } = newTracker();
    tracker.start();
    globalThis.history.replaceState({}, '', '/?utm_source=newsletter');
    globalThis.history.replaceState({}, '', '/?gclid=abc');
    expect(emitted).toHaveLength(1);
    globalThis.history.replaceState({}, '', '/?page=2');
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ path: '/?page=2', previous_path: '/' });
    tracker.stop();
  });

  it('restores the original history methods and listener on stop', () => {
    const { tracker, emitted } = newTracker();
    tracker.start();
    expect(globalThis.history.pushState).not.toBe(originalPushState);
    tracker.stop();

    expect(globalThis.history.pushState).toBe(originalPushState);
    expect(globalThis.history.replaceState).toBe(originalReplaceState);
    globalThis.history.pushState({}, '', '/after-stop');
    globalThis.dispatchEvent(new Event('popstate'));
    expect(emitted).toHaveLength(1);
  });

  it('keeps the original history behaviour while patched', () => {
    const { tracker } = newTracker();
    tracker.start();
    globalThis.history.pushState({ step: 2 }, '', '/wizard?a=1');
    expect(globalThis.location.pathname).toBe('/wizard');
    expect(globalThis.history.state).toEqual({ step: 2 });
    tracker.stop();
  });

  it('is inert without history or location', () => {
    vi.stubGlobal('history', undefined);
    vi.stubGlobal('location', undefined);
    const { tracker, emitted } = newTracker();
    expect(() => {
      tracker.start();
      tracker.stop();
    }).not.toThrow();
    expect(emitted).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('survives a frozen history', () => {
    const frozen = Object.freeze({
      pushState: originalPushState,
      replaceState: originalReplaceState,
    });
    vi.stubGlobal('history', frozen);
    const { tracker, emitted } = newTracker();
    expect(() => {
      tracker.start();
    }).not.toThrow();
    expect(emitted).toHaveLength(1);
    tracker.stop();
    vi.unstubAllGlobals();
  });
});

describe('PageviewTracker across the page lifecycle', () => {
  beforeEach(() => {
    originalReplaceState.call(globalThis.history, {}, '', '/');
  });

  afterEach(() => {
    globalThis.history.pushState = originalPushState;
    globalThis.history.replaceState = originalReplaceState;
  });

  it('does not report the page again when init runs twice (StrictMode, HMR)', () => {
    const first = newTracker();
    first.tracker.start();
    first.tracker.stop();
    const second = newTracker();
    second.tracker.start();
    globalThis.history.pushState({}, '', '/pricing');
    second.tracker.stop();
    expect(first.emitted).toHaveLength(1);
    expect(second.emitted).toEqual([
      expect.objectContaining({ path: '/pricing', previous_path: '/' }),
    ]);
  });

  it('reports a page restored from the back/forward cache', () => {
    const { tracker, emitted } = newTracker();
    tracker.start();
    globalThis.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    globalThis.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    tracker.stop();
    expect(emitted.map((props) => props.path)).toEqual(['/', '/']);
  });

  it('counts a hash navigation once in hashMode, though popstate fires too', () => {
    const { tracker, emitted } = newTracker({ hashMode: true });
    tracker.start();
    originalPushState.call(globalThis.history, {}, '', '/#/orders');
    globalThis.dispatchEvent(new Event('popstate'));
    globalThis.dispatchEvent(new Event('hashchange'));
    tracker.stop();
    expect(emitted.map((props) => props.path)).toEqual(['/', '/#/orders']);
  });

  it('waits for a prerendered page to be shown', () => {
    Object.defineProperty(document, 'prerendering', { configurable: true, value: true });
    const { tracker, emitted } = newTracker();
    tracker.start();
    expect(emitted).toHaveLength(0);
    Object.defineProperty(document, 'prerendering', { configurable: true, value: false });
    document.dispatchEvent(new Event('prerenderingchange'));
    tracker.stop();
    expect(emitted).toHaveLength(1);
    Reflect.deleteProperty(document, 'prerendering');
  });

  it('drops a same-site referrer: a new tab of this app is not a source', () => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue(`${location.origin}/settings`);
    const { tracker, emitted } = newTracker();
    tracker.start();
    tracker.stop();
    expect(emitted[0]).not.toHaveProperty('referrer');
    vi.restoreAllMocks();
  });
});
