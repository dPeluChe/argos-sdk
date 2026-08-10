import { ArgosClient } from './client.js';
import { instrumentFetch as wrapFetch, type InstrumentFetchOptions } from './instrument.js';
import type { Correlation, InitOptions, Props } from './types.js';
import type { TraceHeaders } from './trace.js';

export { ArgosClient } from './client.js';
export { parseDsn, type Endpoint } from './dsn.js';
export { SESSION_IDLE_MS } from './session.js';
export { baggage, traceparent, newTrace, type TraceContext, type TraceHeaders } from './trace.js';
export { isAllowedOrigin, type InstrumentFetchOptions } from './instrument.js';
export { pageKey, PageviewTracker } from './pageviews.js';
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

export function init(options: InitOptions): ArgosClient {
  current?.close();
  current = new ArgosClient(options);
  return current;
}

export function getClient(): ArgosClient | undefined {
  return current;
}

// Every entry point is a no-op before init: analytics must never break the host app.
export function track(name: string, props?: Props): void {
  current?.track(name, props);
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

export function close(): void {
  current?.close();
  current = undefined;
}
