import type { Log } from './debug.js';
import { heartbeatUrl, type Endpoint } from './dsn.js';
import { deliver } from './transport.js';

declare const __ARGOS_VERSION__: string;

export interface SdkInfo {
  name: string;
  version: string;
}

/** `POST /api/{project}/heartbeat/`: proves an install is live. No ids, no personal data. */
export interface HeartbeatPayload {
  environment: string;
  release: string | null;
  runtime: 'browser' | 'node';
  sdk: SdkInfo;
  sentry: SdkInfo | null;
}

interface SentryClient {
  getOptions?: () => { _metadata?: { sdk?: Partial<SdkInfo> } } | undefined;
}
interface SentryScope {
  getClient?: () => SentryClient | undefined;
}
interface SentryCarrier {
  defaultCurrentScope?: SentryScope;
}

/**
 * Best effort, read off the global carrier every Sentry SDK since v8 keeps
 * (`__SENTRY__[version]`), so no Sentry package is imported. Null when absent.
 */
export function detectSentry(): SdkInfo | null {
  try {
    const root = (globalThis as { __SENTRY__?: Record<string, unknown> & { version?: string } })
      .__SENTRY__;
    const version = root?.version;
    if (typeof version !== 'string') return null;
    const carrier = root?.[version] as SentryCarrier | undefined;
    const sdk = carrier?.defaultCurrentScope?.getClient?.()?.getOptions?.()?._metadata?.sdk;
    return { name: sdk?.name ?? 'sentry', version: sdk?.version ?? version };
  } catch {
    return null;
  }
}

let sent: string | undefined;

/**
 * Fire and forget, at most once per `period` in this JS realm, and one
 * macrotask late so a `Sentry.init` on the line after ours is still detected.
 */
export function sendHeartbeat(
  period: string,
  endpoint: Endpoint,
  payload: Omit<HeartbeatPayload, 'sentry' | 'sdk'>,
  sdkName: string,
  log: Log | undefined,
): void {
  if (sent === period) return;
  sent = period;
  setTimeout(() => {
    const body: HeartbeatPayload = {
      ...payload,
      sdk: { name: sdkName, version: __ARGOS_VERSION__ },
      sentry: detectSentry(),
    };
    // `deliver` never rejects: a failure resolves false.
    void deliver(heartbeatUrl(endpoint), endpoint.publicKey, JSON.stringify(body), log).then((ok) =>
      log?.(`heartbeat ${ok ? 'delivered' : 'failed'}`),
    );
  }, 0);
}
