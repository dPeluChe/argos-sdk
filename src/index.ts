import { ArgosClient } from './client.js';
import { instrumentFetch as wrapFetch, type InstrumentFetchOptions } from './instrument.js';
import { correlate, type CorrelatableEvent } from './sentry.js';
import type { Correlation, InitOptions, Props } from './types.js';
import type { TraceHeaders } from './trace.js';

export { ArgosClient } from './client.js';
export { parseDsn, type Endpoint } from './dsn.js';
export { type ConsentState } from './consent.js';
export { SESSION_IDLE_MS } from './session.js';
export { baggage, traceparent, newTrace, type TraceContext, type TraceHeaders } from './trace.js';
export { isAllowedOrigin, type InstrumentFetchOptions } from './instrument.js';
export { browserProps, campaignProps } from './context.js';
export { correlate, type CorrelatableEvent } from './sentry.js';
export { pageKey, PageviewTracker } from './pageviews.js';
export { ClickTracker, eventFrom, EVENT_ATTRIBUTE } from './clicks.js';
export {
  rate,
  VitalsCollector,
  type VitalName,
  type VitalRating,
  type VitalReport,
} from './vitals.js';
export type {
  ArgosEvent,
  AutoPageviewOptions,
  Correlation,
  EventBatch,
  IdentifyPayload,
  InitOptions,
  Props,
} from './types.js';

let current: ArgosClient | undefined;

/**
 * Starts the client, and **never throws**. A DSN is typed by hand into an
 * environment variable at deploy time, and this call runs first, at the top of
 * an application's entry — so a typo in it must not be the thing that stops the
 * product booting. Telemetry that can take down what it observes is worse than
 * no telemetry.
 *
 * The failure is loud in the console and silent everywhere else: `undefined`
 * comes back, every other entry point stays the no-op it already is before
 * `init`, and nothing is sent. `parseDsn` and `resolveEndpoint` still throw for
 * callers that want to validate a DSN rather than run on one.
 */
export function init(options: InitOptions): ArgosClient | undefined {
  current?.close();
  try {
    current = new ArgosClient(options);
  } catch (cause) {
    current = undefined;
    // The only channel an SDK has when it cannot start: it has no transport
    // yet, and throwing is the thing this exists to stop doing.
    console.error('argos: disabled, init failed —', cause);
  }
  return current;
}

export function grantConsent(): void {
  current?.grantConsent();
}

export function revokeConsent(): void {
  current?.revokeConsent();
}

export function getClient(): ArgosClient | undefined {
  return current;
}

// Every entry point is a no-op before init: analytics must never break the host app.
export function track(name: string, props?: Props): void {
  current?.track(name, props);
}

/** The tenant this visit belongs to. Pass a stable identifier, never a display
 *  name — see `ArgosClient.account`. */
export function account(accountId: string): void {
  current?.account(accountId);
}

export function signOut(): void {
  current?.signOut();
}

export function identify(userId: string): void {
  current?.identify(userId);
}

export function pageview(path?: string): void {
  current?.pageview(path);
}

export function flush(): Promise<void> {
  return current?.flush() ?? Promise.resolve();
}

/**
 * The correlation keys, or undefined before `init`. Call it per event rather
 * than once: the session is renewed after 30 minutes of inactivity.
 */
export function correlation(): Correlation | undefined {
  return current?.correlation();
}

export function traceHeaders(): TraceHeaders | undefined {
  return current?.traceHeaders();
}

export function instrumentFetch(options?: InstrumentFetchOptions): () => void {
  return current ? wrapFetch(current, options) : () => undefined;
}

/**
 * Drop-in for `Sentry.init({ beforeSend })`, so errors join the session the
 * clicks are already in. A no-op before `init` and after `close`, and it
 * returns the event either way — a `beforeSend` that returned nothing would
 * discard the error, which is the one failure mode an error reporter must not
 * have.
 *
 * Composes with an existing hook: `null` (dropped) stays `null`, and a promise
 * is awaited and its event correlated.
 */
export function argosBeforeSend(event: null): null;
export function argosBeforeSend<E extends CorrelatableEvent & object>(
  event: PromiseLike<E | null>,
): PromiseLike<(E & CorrelatableEvent) | null>;
export function argosBeforeSend<E extends CorrelatableEvent & object>(
  event: E,
): E & CorrelatableEvent;
export function argosBeforeSend<E extends CorrelatableEvent & object>(
  event: E | PromiseLike<E | null> | null,
): E | PromiseLike<E | null> | null;
export function argosBeforeSend<E extends CorrelatableEvent & object>(
  event: E | PromiseLike<E | null> | null,
): E | PromiseLike<E | null> | null {
  if (event === null) return null;
  if ('then' in event && typeof event.then === 'function') {
    return Promise.resolve(event).then((resolved) => argosBeforeSend(resolved));
  }
  return current === undefined ? event : correlate(event as E, current);
}

export function close(): void {
  current?.close();
  current = undefined;
}
