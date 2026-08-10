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
}
