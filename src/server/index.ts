import { logger, type Log } from '../debug.js';
import { resolveEndpoint, eventsUrl, type Endpoint } from '../dsn.js';
import { newSpanId, uuidv4 } from '../ids.js';
import { deliver } from '../transport.js';
import type { ArgosEvent, InitOptions, Props } from '../types.js';
import { spineFrom, type HeaderSource, type Spine } from './spine.js';

export { spineFrom, parseBaggage, type Spine, type HeaderSource } from './spine.js';

/**
 * The server half. It sends product events that happened where no browser was
 * looking — an invoice charged, a quota consumed, a job that finished — and it
 * puts them on the same session timeline as the click that started them.
 *
 * There is no consent gate here and that is not an oversight: consent is a
 * decision made in a browser, and this only ever continues a visit that already
 * passed that gate before it sent the headers.
 *
 * Errors are not this SDK's job. Any Sentry SDK reports them to Argos by
 * changing its DSN, so building a second way to do it would be work spent to
 * make somebody choose.
 */
export class ArgosServer {
  private readonly endpoint: Endpoint;
  private readonly environment: string;
  private readonly release: string | undefined;
  private readonly log: Log | undefined;
  private pending: ArgosEvent[] = [];

  constructor(options: InitOptions) {
    this.endpoint = resolveEndpoint(options);
    this.log = logger(options.debug);
    this.log?.(`init ${this.endpoint.baseUrl} project ${this.endpoint.projectId}`);
    this.environment = options.environment ?? 'production';
    this.release = options.release;
  }

  /**
   * The visit this request belongs to, or `undefined` when it came from
   * somewhere that is not an instrumented page — a cron, a webhook, a script.
   * Those have no session, and inventing one for them would put a nightly job
   * in the visitor count.
   */
  visit(headers: HeaderSource): Visit | undefined {
    const spine = spineFrom(headers);
    this.log?.(
      spine
        ? `visit ${spine.sessionId} trace ${spine.traceId}`
        : 'no visit: request lacks traceparent or argos baggage',
    );
    return spine ? new Visit(this, spine) : undefined;
  }

  /** @internal — a Visit hands its finished events here. */
  accept(event: ArgosEvent): void {
    this.log?.(`queue ${event.kind} ${event.name}`);
    this.pending.push(event);
  }

  /**
   * Sends what has been collected. A server has no page-hide to flush on, so
   * this is explicit: call it before the response, or on an interval, or at
   * the end of a job. Returns whether the batch was delivered — a caller that
   * cares can decide to retry, and one that does not can ignore it.
   */
  async flush(): Promise<boolean> {
    const batch = this.pending;
    if (batch.length === 0) return true;
    this.pending = [];
    const body = JSON.stringify({ sent_at: new Date().toISOString(), events: batch });
    const delivered = await deliver(
      eventsUrl(this.endpoint),
      this.endpoint.publicKey,
      body,
      this.log,
    );
    this.log?.(`flush ${String(batch.length)}: ${delivered ? 'delivered' : 'failed'}`);
    return delivered;
  }

  /** @internal */
  get context(): { environment: string; release: string | undefined } {
    return { environment: this.environment, release: this.release };
  }
}

/** One request, carrying the visit it belongs to. */
export class Visit {
  constructor(
    private readonly server: ArgosServer,
    readonly spine: Spine,
  ) {}

  track(name: string, props?: Props): void {
    const { environment, release } = this.server.context;
    const event: ArgosEvent = {
      event_id: uuidv4(),
      event_time: new Date().toISOString(),
      kind: 'product',
      name,
      session_id: this.spine.sessionId,
      anon_id: this.spine.anonId,
      trace_id: this.spine.traceId,
      // A span of its own: this work is not the browser's operation. The
      // parent link is not sent because the product wire has no
      // `parent_span_id` -- see `event.Inbound` in argos-workers -- and
      // inventing a field the ingest would ignore is worse than the gap. The
      // trace id is what joins them, and it is exact.
      span_id: newSpanId(),
      environment,
      platform: 'server',
    };
    if (this.spine.userId) event.user_id = this.spine.userId;
    if (this.spine.accountId) event.account_id = this.spine.accountId;
    if (release) event.release = release;
    if (props) event.props = props;
    this.server.accept(event);
  }
}

export function initServer(options: InitOptions): ArgosServer {
  return new ArgosServer(options);
}
