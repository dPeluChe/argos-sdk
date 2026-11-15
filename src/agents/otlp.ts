import { newSpanId } from '../ids.js';

export type Value =
  { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
export type Attrs = Record<string, Value>;

export const str = (stringValue: string): Value => ({ stringValue });
export const dbl = (doubleValue: number): Value => ({ doubleValue });
// OTLP/JSON int64 is a decimal string; a NaN count would not parse server-side.
export const int = (n: number): Value => ({
  intValue: String(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0),
});

const MAX_CUSTOM = 32;
const MAX_KEY = 128;
const MAX_TEXT = 512;

/** `gen_ai.*` and `argos.*` are the SDK's namespaces; `error.type` is set when a span fails. */
const reserved = (key: string): boolean =>
  key.startsWith('gen_ai.') || key.startsWith('argos.') || key === 'error.type';

function scalar(value: unknown): Value | undefined {
  if (typeof value === 'string') return str(value.slice(0, MAX_TEXT));
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

/**
 * The caller's own span attributes. Reserved keys, bad keys, values that are not
 * a string, boolean or finite number, and entries past the 32nd are dropped;
 * `onDrop` says why, for the debug log.
 */
export function customAttrs(input: unknown, onDrop: (key: string, why: string) => void): Attrs {
  const out: Attrs = {};
  if (typeof input !== 'object' || input === null) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(input)) {
    if (reserved(key)) onDrop(key, 'reserved key');
    else if (key === '' || key.length > MAX_KEY) onDrop(key, 'bad key');
    else if (kept >= MAX_CUSTOM) onDrop(key, 'over the 32 attribute cap');
    else {
      const typed = scalar(value);
      if (!typed) onDrop(key, 'value is not a string, boolean or finite number');
      else {
        out[key] = typed;
        kept++;
      }
    }
  }
  return out;
}

export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;
export const KIND_INTERNAL = 1;
export const KIND_CLIENT = 3;

/** A span being built: times are epoch milliseconds, ids are lowercase hex. */
export interface Draft {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startMs: number;
  endMs?: number;
  attrs: Attrs;
  status: { code: number; message?: string };
}

export function draft(
  traceId: string,
  name: string,
  kind: number,
  attrs: Attrs,
  parentSpanId?: string,
): Draft {
  const span: Draft = {
    traceId,
    spanId: newSpanId(),
    name,
    kind,
    startMs: Date.now(),
    attrs,
    status: { code: STATUS_UNSET },
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;
  return span;
}

const nano = (ms: number): string => (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
const list = (attrs: Attrs): { key: string; value: Value }[] =>
  Object.entries(attrs).map(([key, value]) => ({ key, value }));

function encode(span: Draft): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: nano(span.startMs),
    endTimeUnixNano: nano(Math.max(span.endMs ?? span.startMs, span.startMs)),
    attributes: list(span.attrs),
    status: span.status,
  };
}

export function encodeRequest(resource: Attrs, scope: string, spans: Draft[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: list(resource) },
        scopeSpans: [{ scope: { name: scope }, spans: spans.map(encode) }],
      },
    ],
  });
}

/** Content is capped per attribute: a transcript can be megabytes and the ingest body is capped. */
export function capped(value: unknown, max: number): Value | undefined {
  try {
    // JSON.stringify answers undefined for a function or symbol; the throw lands in the catch.
    return str(JSON.stringify(value).slice(0, max));
  } catch {
    return undefined;
  }
}
