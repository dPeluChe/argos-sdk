import type { ArgosClient } from './client.js';

export interface InstrumentFetchOptions {
  /** Origins allowed to receive the headers. Defaults to same-origin only. */
  origins?: (string | RegExp)[];
}

function targetUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Session ids are correlation data, not public: never hand them to a third party by default. */
export function isAllowedOrigin(url: string, origins?: (string | RegExp)[]): boolean {
  const base = (globalThis.location as Location | undefined)?.href;
  let origin: string;
  try {
    origin = new URL(url, base).origin;
  } catch {
    return false;
  }
  if (!origins) return base !== undefined && origin === new URL(base).origin;
  return origins.some((allowed) =>
    typeof allowed === 'string' ? allowed === origin : allowed.test(origin),
  );
}

/** Wraps `window.fetch` to attach `traceparent` and `baggage`. Returns the undo. */
export function instrumentFetch(
  client: ArgosClient,
  options: InstrumentFetchOptions = {},
): () => void {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return () => undefined;

  globalThis.fetch = function argosFetch(input: RequestInfo | URL, init?: RequestInit) {
    if (!isAllowedOrigin(targetUrl(input), options.origins)) return original(input, init);
    const request = new Request(input, init);
    const headers = client.traceHeaders();
    if (!request.headers.has('traceparent'))
      request.headers.set('traceparent', headers.traceparent);
    if (headers.baggage && !request.headers.has('baggage')) {
      request.headers.set('baggage', headers.baggage);
    }
    return original(request);
  };

  return () => {
    globalThis.fetch = original;
  };
}
