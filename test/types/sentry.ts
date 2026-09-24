// Compiled, never run: `npm run typecheck` checks it under tsconfig.types.json.
import type * as Sentry from '@sentry/browser';
import type * as SentryNode from '@sentry/node';
import { argosBeforeSend, correlate, init } from '../../src/index.js';

export const browser: Sentry.BrowserOptions = { beforeSend: argosBeforeSend };

export const node: SentryNode.NodeOptions = { beforeSend: argosBeforeSend };

export const composed: Sentry.BrowserOptions = {
  beforeSend: (event, hint) => (hint.originalException ? argosBeforeSend(event) : event),
};

export function direct(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const client = init({ dsn: 'https://a1b2c3@ingest.invalid/42' });
  return client ? correlate(event, client) : argosBeforeSend(event);
}

// @ts-expect-error tags are a map; the constraint must still reject a wrong shape.
export const rejected = argosBeforeSend({ tags: 'release-1.0' });
