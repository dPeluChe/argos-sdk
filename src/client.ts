import { browserProps, campaignProps } from './context.js';
import { eventsUrl, identifyUrl, resolveEndpoint, type Endpoint } from './dsn.js';
import { uuidv4 } from './ids.js';
import { PageviewTracker } from './pageviews.js';
import { Consent, type ConsentState } from './consent.js';
import { Outbox } from './outbox.js';
import { Identity } from './session.js';
import { createStore } from './storage.js';
import { baggage, newTrace, traceparent, type TraceHeaders } from './trace.js';
import { deliver, Transport } from './transport.js';
import { VitalsCollector } from './vitals.js';
import type { Correlation, ArgosEvent, IdentifyPayload, InitOptions, Props } from './types.js';

const MAX_NAME_LENGTH = 200;

export class ArgosClient {
  private readonly endpoint: Endpoint;
  private readonly consent: Consent;
  private readonly identity: Identity;
  private readonly transport: Transport;
  private readonly environment: string;
  private readonly release: string | undefined;
  private readonly detach: () => void;
  private readonly pageviews: PageviewTracker | undefined;
  private readonly vitals: VitalsCollector | undefined;

  constructor(options: InitOptions) {
    this.endpoint = resolveEndpoint(options);
    const local = createStore('localStorage');
    this.consent = new Consent(local, options.requireConsent ?? false);
    this.identity = new Identity(local, createStore('sessionStorage'));
    this.environment = options.environment ?? 'production';
    this.release = options.release;
    this.transport = new Transport({
      url: eventsUrl(this.endpoint),
      publicKey: this.endpoint.publicKey,
      flushIntervalMs: options.flushIntervalMs ?? 5_000,
      maxBatchSize: options.maxBatchSize ?? 50,
      maxBufferSize: options.maxBufferSize ?? 1_000,
      outbox: new Outbox(local),
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
    // Checked here rather than in the transport: `buildEvent` reads the
    // identity, and reading it is what creates and stores an `anon_id`. The
    // gate has to sit in front of that, not in front of the send.
    if (!this.consent.allowed()) return;
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
  /**
   * The tenant this visit belongs to: the workspace, company or team inside
   * the instrumented application. Sticky like the anon id, so every later
   * event carries it without being told again, and cleared by `signOut`.
   *
   * Pass a **stable identifier** — the row id, a UUID — never a display name.
   * It is stored opaquely and never normalised, so `Acme`, `acme` and `acme `
   * are three different tenants for the rest of time.
   */
  account(accountId: string): void {
    // Behind the same gate as everything else: setting an account writes to
    // this browser, and writing before consent is the thing the gate exists
    // to stop.
    if (!this.consent.allowed()) return;
    this.identity.setAccount(accountId);
  }

  /** Forgets who this is — the person and the tenant — without touching the
   *  anon id, which is about the device and not about them. */
  signOut(): void {
    this.identity.clearUser();
  }

  identify(userId: string): void {
    if (!this.consent.allowed()) return;
    this.identity.setUserId(userId);
    const payload: IdentifyPayload = { anon_id: this.identity.anonId(), user_id: userId };
    void deliver(identifyUrl(this.endpoint), this.endpoint.publicKey, JSON.stringify(payload));
  }

  /** The visitor said yes. Events from here on are collected; the ones before
   *  it are gone on purpose. */
  grantConsent(): void {
    this.consent.grant();
  }

  /** The visitor said no, and it sticks across installs that do not require a
   *  gate — see `Consent.revoke`. */
  revokeConsent(): void {
    this.consent.revoke();
  }

  consentState(): ConsentState {
    return this.consent.state();
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
      // The user and the tenant travel too, so a server that continues this
      // visit stamps them without being told again. Same-origin only, which
      // `instrumentFetch` enforces before these are ever attached.
      baggage: baggage({
        'argos.session_id': this.identity.sessionId(),
        'argos.anon_id': this.identity.anonId(),
        'argos.user_id': this.identity.userId(),
        'argos.account_id': this.identity.accountId(),
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
    const accountId = this.identity.accountId();
    if (accountId) event.account_id = accountId;
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
