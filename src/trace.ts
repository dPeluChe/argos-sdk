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

/**
 * Ours plus what another tracer already wrote: our keys replaced, a repeated
 * foreign key kept once, and foreign members past the W3C limits (64, 8192
 * bytes) dropped whole, since the argos ones are what a server needs.
 */
export function mergeBaggage(existing: string | null, ours: string): string {
  const members = ours.split(',');
  const seen = new Set(members.map(keyOf));
  for (const raw of existing?.split(',') ?? []) {
    const member = raw.trim();
    const key = keyOf(member);
    if (!key || key.startsWith('argos.') || seen.has(key)) continue;
    if (members.length > 63 || `${members.join(',')},${member}`.length > 8192) break;
    seen.add(key);
    members.push(member);
  }
  return members.join(',');
}

const keyOf = (member: string): string => (member.split('=')[0] ?? '').trim();
