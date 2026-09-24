import type { Log } from './debug.js';
import type { Outbox } from './outbox.js';
import type { ArgosEvent, EventBatch } from './types.js';

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const JSON_TYPE = 'application/json';

export interface RetryPlan {
  retry: boolean;
  delayMs: number;
}

export interface Attempt {
  /** `null` means the request never got an answer — DNS, offline, CORS, aborted. */
  status: number | null;
  retryAfter: string | null;
}

export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (header.trim() !== '' && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * Retry network errors, 429 and 5xx. Every other 4xx is a permanent client bug
 * — a bad key, a malformed body — and retrying it just loops forever.
 */
export function planRetry(
  { status, retryAfter }: Attempt,
  attempt: number,
  rand: () => number = Math.random,
): RetryPlan {
  const retryable = status === null || status === 429 || status >= 500;
  if (!retryable || attempt >= MAX_ATTEMPTS - 1) return { retry: false, delayMs: 0 };
  const honored = status === 429 ? retryAfterMs(retryAfter) : null;
  const backoff = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return { retry: true, delayMs: honored ?? Math.round(backoff * (0.5 + rand() * 0.5)) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(url: string, publicKey: string, body: string, log?: Log): Promise<Attempt> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': JSON_TYPE, 'X-Argos-Key': publicKey },
      body,
    });
    if (log) {
      const { status } = response;
      const detail = status >= 400 && status < 500 ? await response.text().catch(() => '') : '';
      log(`ingest ${String(status)} ${detail.slice(0, 300)}`.trim());
    }
    return { status: response.status, retryAfter: response.headers.get('Retry-After') };
  } catch {
    log?.('ingest unreachable');
    return { status: null, retryAfter: null };
  }
}

/** POST with backoff. Resolves `false` when the payload was given up on. */
export async function deliver(
  url: string,
  publicKey: string,
  body: string,
  log?: Log,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const result = await post(url, publicKey, body, log);
    if (result.status !== null && result.status < 400) return true;
    const plan = planRetry(result, attempt);
    if (!plan.retry) return false;
    log?.(`retry ${String(attempt + 1)} in ${String(plan.delayMs)}ms`);
    await sleep(plan.delayMs);
  }
}

export interface TransportConfig {
  url: string;
  publicKey: string;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxBufferSize: number;
  /** Where a batch goes when the network refused it for good, and where the
   *  next visit looks first. Absent in tests that do not care. */
  outbox?: Outbox;
  log?: Log | undefined;
}

export class Transport {
  private readonly buffer: ArgosEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** Cumulative, never reset: a broken endpoint should stay visible in the data. */
  dropped = 0;

  constructor(private readonly config: TransportConfig) {}

  enqueue(event: ArgosEvent): void {
    let overflowed = false;
    while (this.buffer.length >= this.config.maxBufferSize) {
      this.buffer.shift();
      this.dropped += 1;
      overflowed = true;
    }
    if (overflowed) {
      this.config.log?.(`drop oldest: buffer full`);
      event.props = { ...event.props, 'argos.dropped_events': this.dropped };
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.config.maxBatchSize) void this.flush();
  }

  start(): void {
    this.stop();
    // Whatever the last visit could not deliver goes out first: it is the
    // oldest, and the acceptance window it has to reach is a fixed distance
    // from now, not from when it was queued.
    const waiting = this.config.outbox?.take() ?? [];
    if (waiting.length > 0) {
      this.config.log?.(`outbox resend ${String(waiting.length)}`);
      this.buffer.unshift(...waiting);
    }
    const timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
    // A pending interval keeps a Node process alive; browsers return a number with no unref.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Serialized: two overlapping flushes would race on the same buffer. */
  flush(): Promise<void> {
    this.queue = this.queue.then(() => this.drain());
    return this.queue;
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.config.maxBatchSize);
      const { url, publicKey, log } = this.config;
      log?.(`flush ${String(batch.length)} via fetch`);
      const delivered = await deliver(url, publicKey, encode(batch), log);
      if (delivered) continue;
      // `deliver` has already retried everything worth retrying. Keeping the
      // rest of the buffer in memory and looping would spend the visitor's
      // battery on a network that is not there; it waits on disk for the next
      // visit instead. Resending later is free -- ingest deduplicates on the
      // event's own id and time.
      this.save([...batch, ...this.buffer.splice(0, this.buffer.length)]);
      return;
    }
  }

  /**
   * Unload path. `sendBeacon` survives the page dying but cannot set headers,
   * so the key rides in the query string instead.
   *
   * The body goes as a string, i.e. `text/plain`. A beacon always carries
   * credentials, so a JSON-typed one to another origin needs a preflight that
   * `Access-Control-Allow-Origin: *` fails, and the batch is silently dropped.
   */
  flushOnUnload(): void {
    const batch = this.buffer.splice(0, this.buffer.length);
    if (batch.length === 0) return;
    const body = encode(batch);
    const url = `${this.config.url}?argos_key=${encodeURIComponent(this.config.publicKey)}`;
    const nav = globalThis.navigator as Partial<Navigator> | undefined;
    try {
      if (nav?.sendBeacon?.call(nav, url, body)) {
        this.config.log?.(`flush ${String(batch.length)} via beacon`);
        return;
      }
    } catch {
      // Some browsers throw instead of returning false; the batch is already out of the buffer.
    }
    // The page is going. This fetch cannot report back, so the batch is also
    // written down: a duplicate costs nothing and a loss cannot be undone.
    this.config.log?.(`flush ${String(batch.length)} via keepalive`);
    this.save(batch);
    void fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': JSON_TYPE, 'X-Argos-Key': this.config.publicKey },
      body,
    }).catch(() => undefined);
  }

  private save(events: ArgosEvent[]): void {
    this.config.log?.(`outbox kept ${String(events.length)}`);
    this.config.outbox?.save(events);
  }

  get pending(): number {
    return this.buffer.length;
  }
}

function encode(events: ArgosEvent[]): string {
  const batch: EventBatch = { sent_at: new Date().toISOString(), events };
  return JSON.stringify(batch);
}
