import type { KeyValueStore } from './storage.js';
import type { ArgosEvent } from './types.js';

const OUTBOX = 'argos.outbox';

/**
 * Matches `event.MaxBackdate` in argos-workers, and the match is load-bearing
 * rather than tidy.
 *
 * Ingest clamps an `event_time` older than this instead of refusing it, and the
 * stored row's primary key includes that time. So a resend inside the window is
 * a no-op — same key, `ON CONFLICT DO NOTHING` — while a resend past it lands
 * as a *second* row carrying a timestamp that never happened. Dropping here is
 * the only option that neither loses a real event nor invents a fake one.
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many events survive a closed tab. Small on purpose: this is somebody
 * else's browser, the events are worth less the older they are, and a queue
 * that can grow without limit is a bug waiting for a bad network.
 */
export const MAX_EVENTS = 200;

/**
 * What did not make it out before the page died.
 *
 * The unload path already tries `sendBeacon` and then a keepalive fetch, and
 * neither can report back — the page is gone. Whatever is left is written here
 * and enqueued by the next visit. Resending something that did arrive is
 * harmless, because ingest deduplicates on the event's own id and time; losing
 * it is not.
 */
export class Outbox {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Adds to whatever is already waiting, newest kept when over the cap. */
  save(events: readonly ArgosEvent[]): void {
    if (events.length === 0) return;
    const merged = [...this.read(), ...events];
    const kept = merged.slice(-MAX_EVENTS);
    try {
      this.store.set(OUTBOX, JSON.stringify(kept));
    } catch {
      // This is the one thing the SDK writes that is large enough to hit a
      // quota. Failing to keep the events is a loss; throwing while a page is
      // unloading is a loss and a broken page.
    }
  }

  /** Returns what is still worth sending and empties the store, so a failure
   *  to send again cannot double it — the caller owns them from here. */
  take(): ArgosEvent[] {
    const events = this.read();
    if (events.length > 0) this.store.remove(OUTBOX);
    return events;
  }

  private read(): ArgosEvent[] {
    const raw = this.store.get(OUTBOX);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const cutoff = this.now() - MAX_AGE_MS;
      return parsed.filter((event): event is ArgosEvent => usable(event, cutoff));
    } catch {
      // A half-written or foreign value is not a queue. Losing it beats
      // throwing on a page that only wanted to send a pageview.
      return [];
    }
  }
}

function usable(event: unknown, cutoff: number): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const time = (event as { event_time?: unknown }).event_time;
  const id = (event as { event_id?: unknown }).event_id;
  if (typeof time !== 'string' || typeof id !== 'string') return false;
  const at = Date.parse(time);
  return Number.isFinite(at) && at >= cutoff;
}
