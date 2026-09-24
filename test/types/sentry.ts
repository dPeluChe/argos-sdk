// Compiled, never run: `npm run typecheck` checks it under tsconfig.types.json.
import type * as Sentry from '@sentry/browser';
import type * as SentryNode from '@sentry/node';
import { argosBeforeSend, correlate, init } from '../../src/index.js';

export const browser: Sentry.BrowserOptions = { beforeSend: argosBeforeSend };

export const node: SentryNode.NodeOptions = { beforeSend: argosBeforeSend };

export const composed: Sentry.BrowserOptions = {
  beforeSend: (event, hint) => (hint.originalException ? argosBeforeSend(event) : event),
};

type BeforeSend = NonNullable<Sentry.BrowserOptions['beforeSend']>;
declare const existing: BeforeSend;
declare const existingSync: (e: Sentry.ErrorEvent, h: Sentry.EventHint) => Sentry.ErrorEvent | null;
declare const existingAsync: (
  e: Sentry.ErrorEvent,
  h: Sentry.EventHint,
) => Promise<Sentry.ErrorEvent | null>;

export const composedAny: Sentry.BrowserOptions = {
  beforeSend: (e, h) => argosBeforeSend(existing(e, h)),
};

export const composedSync: Sentry.BrowserOptions = {
  beforeSend: (e, h) => argosBeforeSend(existingSync(e, h)),
};

export const composedAsync: Sentry.BrowserOptions = {
  beforeSend: (e, h) => argosBeforeSend(existingAsync(e, h)),
};

export const composedAwait: SentryNode.NodeOptions = {
  beforeSend: async (e, h) => argosBeforeSend(await existingAsync(e, h)),
};

export const dropped: null = argosBeforeSend(null);

export function direct(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const client = init({ dsn: 'https://a1b2c3@ingest.invalid/42' });
  return client ? correlate(event, client) : argosBeforeSend(event);
}

// @ts-expect-error tags are a map; the constraint must still reject a wrong shape.
export const rejected = argosBeforeSend({ tags: 'release-1.0' });
