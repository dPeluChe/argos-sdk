/**
 * The correlation spine, lifted off an incoming request.
 *
 * A product event cannot be stored without `session_id`, `anon_id` and
 * `trace_id` — `events_product_needs_spine` in the DDL says so — and a server
 * has none of its own. It continues the visit that called it instead: the
 * browser SDK already attaches `traceparent` and `baggage` to same-origin
 * requests, and this reads them back.
 *
 * Nothing here invents a spine when one is missing. A request that did not come
 * from an instrumented page is not a visit, and giving it a made-up session id
 * would put a nightly job in the visitor count.
 */
export interface Spine {
  traceId: string;
  /** The browser's span, which this server's work happened under. */
  parentSpanId: string;
  sessionId: string;
  anonId: string;
  userId?: string;
  accountId?: string;
}

/** Whatever a runtime calls a header bag: a web `Headers`, node's plain object,
 *  a framework's own map. A union rather than one shape with an index
 *  signature, because `Headers` has no index signature and would not fit. */
export type HeaderSource =
  { get(name: string): string | null | undefined } | Record<string, unknown>;

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

function header(source: HeaderSource, name: string): string | undefined {
  if ('get' in source && typeof source.get === 'function') {
    return (source.get as (key: string) => string | null | undefined)(name) ?? undefined;
  }
  // Node lowercases incoming header names; a caller passing a plain object may
  // not have, so both spellings are tried before giving up.
  const bag = source as Record<string, unknown>;
  const value = bag[name] ?? bag[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** W3C Baggage, tolerant of the whitespace real proxies add. */
export function parseBaggage(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const entries: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const [key, ...rest] = part.split('=');
    if (!key || rest.length === 0) continue;
    // A baggage entry may carry metadata after a semicolon; it is not the value.
    const value = rest.join('=').split(';')[0] ?? '';
    try {
      entries[key.trim()] = decodeURIComponent(value.trim());
    } catch {
      // A value that is not valid percent-encoding is somebody else's baggage,
      // not ours. Skipping it beats throwing inside a request handler.
    }
  }
  return entries;
}

/**
 * Returns the spine when the request carries a complete one, and `undefined`
 * otherwise — deliberately, so a caller has to decide what a request with no
 * visit behind it means, rather than being handed a plausible-looking blank.
 */
export function spineFrom(headers: HeaderSource): Spine | undefined {
  const trace = TRACEPARENT.exec(header(headers, 'traceparent') ?? '');
  if (!trace) return undefined;

  const bag = parseBaggage(header(headers, 'baggage'));
  const sessionId = bag['argos.session_id'];
  const anonId = bag['argos.anon_id'];
  // All three or none: a partial spine is refused by the database anyway, and
  // failing here is cheaper and says why.
  if (!sessionId || !anonId) return undefined;

  // Destructured, so the compiler carries the pattern's guarantee instead of
  // needing an assertion that says the same thing less honestly.
  const [, traceId, parentSpanId] = trace;
  const spine: Spine = {
    traceId,
    parentSpanId,
    sessionId,
    anonId,
  };
  const userId = bag['argos.user_id'];
  const accountId = bag['argos.account_id'];
  if (userId) spine.userId = userId;
  if (accountId) spine.accountId = accountId;
  return spine;
}
