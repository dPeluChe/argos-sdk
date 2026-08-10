import { newSpanId, newTraceId } from './ids.js';

export interface TraceContext {
  traceId: string;
  spanId: string;
}

export interface TraceHeaders {
  traceparent: string;
  baggage: string;
}

export function newTrace(): TraceContext {
  return { traceId: newTraceId(), spanId: newSpanId() };
}

/** `version-traceid-spanid-flags`; flags `01` = sampled. */
export function traceparent({ traceId, spanId }: TraceContext): string {
  return `00-${traceId}-${spanId}-01`;
}

/**
 * W3C Baggage. `encodeURIComponent` is a safe superset of `baggage-octet`: it
 * escapes every character the grammar forbids and a few it merely allows.
 */
export function baggage(entries: Record<string, string | undefined>): string {
  return Object.entries(entries)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(',');
}
