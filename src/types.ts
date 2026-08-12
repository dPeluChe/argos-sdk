/** Event properties. Serialized to JSONB server-side, so anything JSON-safe goes. */
export type Props = Record<string, unknown>;

/** One product event, exactly as `docs/INGEST_API.md` defines it. */
export interface ArgosEvent {
  event_id: string;
  event_time: string;
  kind: 'product';
  name: string;
  session_id: string;
  anon_id: string;
  user_id?: string;
  /** The tenant this event happened in. Stamped from the sticky value set by
   *  `account()`, absent when nothing set one. */
  account_id?: string;
  trace_id: string;
  span_id: string;
  release?: string;
  environment?: string;
  platform: 'browser';
  props?: Props;
}

export interface EventBatch {
  sent_at: string;
  events: ArgosEvent[];
}

export interface IdentifyPayload {
  anon_id: string;
  user_id: string;
}

export interface AutoPageviewOptions {
  /**
   * Query parameters that do not identify a page. Replaces the built-in list of
   * campaign and click ids; `utm_*` is always ignored on top of it.
   */
  ignoreParams?: string[];
  /** Make the hash part of the page identity, for hash-based routers. Off by default. */
  hashMode?: boolean;
}

export interface InitOptions {
  /** Sentry-shaped DSN: `https://{publicKey}@{host}/{projectId}`. */
  dsn?: string;
  /** Explicit form, an alternative to `dsn`. All three are required together. */
  projectId?: string;
  publicKey?: string;
  host?: string;
  /** Defaults to `production`. */
  environment?: string;
  release?: string;
  /** Defaults to 5000. */
  flushIntervalMs?: number;
  /** Defaults to 50. */
  maxBatchSize?: number;
  /** Defaults to 1000. Oldest events are dropped past this. */
  maxBufferSize?: number;
  /** Emit a `pageview` on load and on SPA navigation. Off by default. */
  autoPageviews?: boolean | AutoPageviewOptions;
  /** Emit one `web_vital` event per metric on page hide. Off by default. */
  webVitals?: boolean;
  /**
   * Store nothing and send nothing until `grantConsent()` is called.
   *
   * Off by default, so upgrading does not silently stop an install's data
   * arriving. A refusal is sticky either way: once `revokeConsent()` has been
   * called, this being off does not resume collection.
   */
  requireConsent?: boolean;
}

/**
 * The keys that tie a foreign event to this visit. Named for the tag keys
 * ingest reads, so the object drops straight onto a Sentry event's `tags`.
 */
export interface Correlation {
  argos_session_id: string;
  argos_anon_id: string;
}
