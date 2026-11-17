/** Event properties. Serialized to JSONB server-side, so anything JSON-safe goes. */
export type Props = Record<string, unknown>;

/** What every event carries, whichever kind it is. */
interface EventBase {
  event_id: string;
  event_time: string;
  name: string;
  user_id?: string;
  /** The tenant this event happened in. Stamped from the sticky value set by
   *  `account()`, absent when nothing set one. */
  account_id?: string;
  release?: string;
  environment?: string;
  /** Where the event was produced. The wire takes any string; these are the
   *  two this SDK emits. */
  platform: 'browser' | 'server';
  props?: Props;
}

/** One product event, exactly as the workspace's `docs/INGEST_API.md` defines
 *  it. The correlation spine is mandatory: it cannot be reconstructed once
 *  the event is stored. */
export interface ProductEvent extends EventBase {
  kind: 'product';
  session_id: string;
  anon_id: string;
  trace_id: string;
  span_id: string;
}

/** A warning about an API on its way out. The spine is optional for this
 *  kind — a cron's warning has no visit behind it — and a browser warning
 *  carries one, which is what answers who the removal will hit. */
export interface DeprecationEvent extends EventBase {
  kind: 'deprecation';
  session_id?: string;
  anon_id?: string;
  trace_id?: string;
  span_id?: string;
}

export type ArgosEvent = ProductEvent | DeprecationEvent;

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

/** Fine-tuning for `deprecations`. Both captureros are on unless turned off. */
export interface DeprecationOptions {
  /** Extra literal phrases that classify a console warning as a deprecation,
   * matched case-insensitively as substrings alongside the built-in net. */
  patterns?: string[];
  /** Watch the browser's own deprecation reports (`ReportingObserver`). On by
   *  default; the only channel that sees engine warnings such as Chrome's
   *  "Fenced Frame API is deprecated". */
  observer?: boolean;
  /** Wrap `console.warn` and send whatever matches a deprecation pattern: the
   *  channel a CDN library's warnings go through. On by default. */
  console?: boolean;
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
  /** Emit one `web_vital` event per metric on page hide. On by default; `false` turns it off. */
  webVitals?: boolean;
  /**
   * Report how long each page is actually looked at, as `page_engagement`
   * events (visible and focused time, plus scroll depth). Sent only for pages
   * that got a pageview, on route change and on hide. On by default; `false`
   * turns it off.
   */
  engagement?: boolean;
  /**
   * Track clicks on elements carrying `data-argos-event`, with
   * `data-argos-event-*` becoming props. Off by default, like the rest.
   *
   * Marked elements only — never every click. A tracker that reports all of
   * them collects the text of whatever a person clicked, which is a privacy
   * problem the install did not ask for.
   */
  autoClicks?: boolean;
  /**
   * Report warnings about APIs on their way out as `deprecation` events: a
   * CDN library's `console.warn`, the browser's own deprecation reports
   * (`ReportingObserver`). Off by default; `true` turns on both captureros.
   *
   * The point is lead time: the warning sits in the console for months
   * before the removal breaks the app, and nobody watches the console.
   */
  deprecations?: boolean | DeprecationOptions;
  /**
   * Store nothing and send nothing until `grantConsent()` is called.
   *
   * Off by default, so upgrading does not silently stop an install's data
   * arriving. A refusal is sticky either way: once `revokeConsent()` has been
   * called, this being off does not resume collection.
   */
  requireConsent?: boolean;
  /** Log what the SDK does to the console with an `[argos]` prefix. Off by default. */
  debug?: boolean;
  /**
   * One heartbeat at startup (per process on a server, per day in a browser),
   * so `/check` can show the install is live. On by default; `false` opts out.
   */
  heartbeat?: boolean;
  /**
   * Stamp pageviews with `visitor_id`, a random id kept in `localStorage` that
   * recognises a returning browser. On by default; `false` neither creates nor
   * sends it. Never sent when consent is missing or storage is unavailable.
   */
  trackVisitor?: boolean;
}

/**
 * The keys that tie a foreign event to this visit. Named for the tag keys
 * ingest reads, so the object drops straight onto a Sentry event's `tags`.
 */
export interface Correlation {
  argos_session_id: string;
  argos_anon_id: string;
  /** Absent until `identify` is called — a tag whose value is `undefined`
   *  serialises as a null the ingest would have to reject, so it is omitted. */
  argos_user_id?: string;
  /** Absent until `account` is called. */
  argos_account_id?: string;
}
