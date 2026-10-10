import type { Log } from './debug.js';
import { heartbeatUrl, type Endpoint } from './dsn.js';
import { deliverForAnswer } from './transport.js';

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

/** -1, 0 or 1; a pre-release tail is ignored. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string): number[] =>
    version
      .split('-')[0]
      ?.split('.')
      .map((part) => Number(part) || 0) ?? [];
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** For the developer: a production page in a visitor's browser stays quiet. See README. */
export function updateNotice(
  installed: string,
  answer: unknown,
  audience: { debug: boolean; environment: string; runtime: 'browser' | 'node' },
): string | null {
  const latest = (answer as { latest_sdk?: unknown } | null)?.latest_sdk;
  if (typeof latest !== 'string' || compareVersions(installed, latest) >= 0) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$|\.(local|localhost|test)$/.test(
    (globalThis.location as Location | undefined)?.hostname ?? '',
  );
  const developer =
    audience.debug || audience.runtime === 'node' || audience.environment !== 'production' || local;
  if (!developer) return null;
  return (
    `argos: @argos/browser ${installed} is installed and ${latest} is available. ` +
    `Update: npm install https://github.com/dPeluChe/argos-sdk/releases/download/v${latest}/argos-browser-${latest}.tgz`
  );
}

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
  const debug = log !== undefined;
  if (sent === period) return;
  sent = period;
  setTimeout(() => {
    const body: HeartbeatPayload = {
      ...payload,
      sdk: { name: sdkName, version: __ARGOS_VERSION__ },
      sentry: detectSentry(),
    };
    void deliverForAnswer(
      heartbeatUrl(endpoint),
      endpoint.publicKey,
      JSON.stringify(body),
      log,
    ).then((answer) => {
      log?.(`heartbeat ${answer === false ? 'failed' : 'delivered'}`);
      const notice = updateNotice(__ARGOS_VERSION__, answer, {
        debug,
        environment: payload.environment,
        runtime: payload.runtime,
      });
      if (notice) console.warn(notice);
    });
  }, 0);
}
