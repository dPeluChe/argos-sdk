import { browserProps, campaignProps } from './context.js';
import { eventsUrl, identifyUrl, resolveEndpoint, type Endpoint } from './dsn.js';
import { uuidv4 } from './ids.js';
import { PageviewTracker } from './pageviews.js';
import { Identity } from './session.js';
import { createStore } from './storage.js';
import { baggage, newTrace, traceparent, type TraceHeaders } from './trace.js';
import { deliver, Transport } from './transport.js';
import { VitalsCollector } from './vitals.js';
import type { Correlation, ArgosEvent, IdentifyPayload, InitOptions, Props } from './types.js';

const MAX_NAME_LENGTH = 200;

export class ArgosClient {
  private readonly endpoint: Endpoint;
  private readonly identity: Identity;
  private readonly transport: Transport;
  private readonly environment: string;
  private readonly release: string | undefined;
  private readonly detach: () => void;
  private readonly pageviews: PageviewTracker | undefined;
  private readonly vitals: VitalsCollector | undefined;

  constructor(options: InitOptions) {
    this.endpoint = resolveEndpoint(options);
    this.identity = new Identity(createStore('localStorage'), createStore('sessionStorage'));
    this.environment = options.environment ?? 'production';
    this.release = options.release;
    this.transport = new Transport({
      url: eventsUrl(this.endpoint),
      publicKey: this.endpoint.publicKey,
      flushIntervalMs: options.flushIntervalMs ?? 5_000,
      maxBatchSize: options.maxBatchSize ?? 50,
      maxBufferSize: options.maxBufferSize ?? 1_000,
    });
    this.transport.start();
    // Vitals report into the same batch the unload flush is about to send.
    this.detach = onPageHidden(() => {
      this.vitals?.finalize();
      this.transport.flushOnUnload();
    });

    if (options.autoPageviews) {
      this.pageviews = new PageviewTracker(
        (props) => {
          this.track('pageview', this.pageviewProps(props));
        },
        typeof options.autoPageviews === 'object' ? options.autoPageviews : {},
      );
      this.pageviews.start();
    }

    if (options.webVitals === true) {
      this.vitals = new VitalsCollector((report) => {
        const props: Props = {
          metric: report.metric,
          value: report.value,
          rating: report.rating,
        };
        const path = (globalThis.location as Location | undefined)?.pathname;
        if (path) props.path = path;
        this.track('web_vital', props);
      });
      this.vitals.start();
    }
  }

  track(name: string, props?: Props): void {
    this.transport.enqueue(this.buildEvent(name, props));
  }

  pageview(path?: string): void {
    const loc = globalThis.location as Location | undefined;
    const props: Props = { path: path ?? loc?.pathname ?? '/' };
    const referrer = (globalThis.document as Document | undefined)?.referrer;
    if (referrer) props.referrer = referrer;
    this.track('pageview', this.pageviewProps(props));
  }

  /**
   * Campaign tags are re-read from the live URL every time and never
   * remembered, so a later pageview without one reports none and the server
   * keeps the first. Screen and language cannot change mid-visit: once is enough.
   */
  private pageviewProps(props: Props): Props {
    const search = (globalThis.location as Location | undefined)?.search ?? '';
    const enriched: Props = { ...props, ...campaignProps(search) };
    if (this.identity.claimEntry()) Object.assign(enriched, browserProps());
    return enriched;
  }

  /** Stamps `user_id` on later events and writes the alias. Past events are never rewritten. */
  identify(userId: string): void {
    this.identity.setUserId(userId);
    const payload: IdentifyPayload = { anon_id: this.identity.anonId(), user_id: userId };
    void deliver(identifyUrl(this.endpoint), this.endpoint.publicKey, JSON.stringify(payload));
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  /**
   * The correlation keys, for stamping onto an event this SDK does not own —
   * a Sentry error, say. Read them per event: the session is renewed after
   * 30 minutes of inactivity, so a value captured once goes stale.
   */
  correlation(): Correlation {
    return {
      argos_session_id: this.identity.sessionId(),
      argos_anon_id: this.identity.anonId(),
    };
  }

  /** Headers for an outbound request, so backend events land in the same session. */
  traceHeaders(): TraceHeaders {
    return {
      traceparent: traceparent(newTrace()),
      baggage: baggage({
        'argos.session_id': this.identity.sessionId(),
        'argos.anon_id': this.identity.anonId(),
      }),
    };
  }

  close(): void {
    this.detach();
    this.pageviews?.stop();
    this.vitals?.stop();
    this.transport.stop();
  }

  private buildEvent(name: string, props?: Props): ArgosEvent {
    const trace = newTrace();
    const event: ArgosEvent = {
      event_id: uuidv4(),
      event_time: new Date().toISOString(),
      kind: 'product',
      name: name.slice(0, MAX_NAME_LENGTH),
      session_id: this.identity.sessionId(),
      anon_id: this.identity.anonId(),
      trace_id: trace.traceId,
      span_id: trace.spanId,
      environment: this.environment,
      platform: 'browser',
    };
    const userId = this.identity.userId();
    if (userId) event.user_id = userId;
    if (this.release) event.release = this.release;
    if (props) event.props = props;
    return event;
  }
}

function onPageHidden(handler: () => void): () => void {
  const doc = globalThis.document as Document | undefined;
  if (!doc) return () => undefined;
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') handler();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  globalThis.addEventListener('pagehide', handler);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    globalThis.removeEventListener('pagehide', handler);
  };
}
