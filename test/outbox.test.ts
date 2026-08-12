import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_AGE_MS, MAX_EVENTS, Outbox } from '../src/outbox.js';
import { memoryStore } from '../src/storage.js';
import type { ArgosEvent } from '../src/types.js';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');

function event(id: string, at: number = NOW): ArgosEvent {
  return {
    event_id: id,
    event_time: new Date(at).toISOString(),
    kind: 'product',
    name: 'checkout_started',
    session_id: '0192f3a7-1c2e-7c31-9a1e-6f0b8c2d4e5a',
    anon_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    span_id: '00f067aa0ba902b7',
    platform: 'browser',
  };
}

describe('what did not make it out before the page died', () => {
  let store = memoryStore();

  beforeEach(() => {
    store = memoryStore();
  });

  it('comes back on the next visit, once', () => {
    const outbox = new Outbox(store, () => NOW);
    outbox.save([event('a'), event('b')]);

    expect(outbox.take().map((e) => e.event_id)).toEqual(['a', 'b']);
    // Emptied by the taking: the caller owns them now, and a second read would
    // send them twice on a page that already has them in its buffer.
    expect(outbox.take()).toEqual([]);
  });

  it('drops what ingest would no longer store faithfully', () => {
    const outbox = new Outbox(store, () => NOW);
    outbox.save([event('fresh', NOW - 1000), event('stale', NOW - MAX_AGE_MS - 1000)]);

    // Past MaxBackdate ingest clamps the time instead of refusing it, and the
    // stored row's key includes that time — so a resend lands as a second row
    // dated to a moment that never happened. Dropping is the honest option.
    expect(outbox.take().map((e) => e.event_id)).toEqual(['fresh']);
  });

  it('keeps the newest when it overflows, not the oldest', () => {
    const outbox = new Outbox(store, () => NOW);
    outbox.save(Array.from({ length: MAX_EVENTS + 10 }, (_, i) => event(`e${String(i)}`)));

    const kept = outbox.take();
    expect(kept).toHaveLength(MAX_EVENTS);
    expect(kept.at(-1)?.event_id).toBe(`e${String(MAX_EVENTS + 9)}`);
  });

  it('treats an unreadable queue as no queue, rather than throwing on a pageview', () => {
    store.set('argos.outbox', '{ not json');
    const outbox = new Outbox(store, () => NOW);

    expect(() => outbox.take()).not.toThrow();
    expect(outbox.take()).toEqual([]);
  });

  it('ignores entries that are not events at all', () => {
    store.set('argos.outbox', JSON.stringify([{ nothing: true }, event('real')]));
    const outbox = new Outbox(store, () => NOW);

    expect(outbox.take().map((e) => e.event_id)).toEqual(['real']);
  });

  it('survives a store that refuses to be written', () => {
    const readOnly = {
      get: () => null,
      set: () => {
        throw new Error('quota');
      },
      remove: () => {
        /* nothing to forget in a store that never kept anything */
      },
    };

    // A browser out of storage must not take the page down with it. Our own
    // stores already swallow this; the guard is here because the queue is the
    // one thing that writes a large value and so is the one that hits a quota.
    expect(() => {
      new Outbox(readOnly, () => NOW).save([event('a')]);
    }).not.toThrow();
  });
});

describe('the page dying with events still in hand', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('writes them down when the beacon will not take them', async () => {
    // No sendBeacon and a fetch that never resolves: the page is going and
    // nothing can report back, which is exactly when the queue earns its keep.
    vi.stubGlobal('navigator', {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const { init, track } = await import('../src/index.js');

    init({ dsn: 'https://0123456789abcdef0123456789abcdef@ingest.example.com/42' });
    track('checkout_started');
    // The real trigger. `close()` only stops the timers; the unload path is
    // what the browser gives us and what has to write the queue.
    globalThis.dispatchEvent(new Event('pagehide'));

    const waiting: unknown = JSON.parse(localStorage.getItem('argos.outbox') ?? '[]');
    expect(Array.isArray(waiting) && waiting.length).toBeGreaterThan(0);
  });
});
