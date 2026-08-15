import type { ArgosClient } from './client.js';

/**
 * The shape this needs off a Sentry event, declared structurally so no Sentry
 * package is imported. Keeping zero runtime dependencies is the reason; the
 * happy side effect is that this works against every Sentry SDK major, since
 * `tags` and `user.id` have not changed across any of them.
 */
export interface CorrelatableEvent {
  tags?: Record<string, unknown>;
  user?: { id?: string | number; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Stamps this visit onto an event Argos does not own, so an error and the
 * clicks around it land in one session.
 *
 * Read per event, never cached: the session is renewed after 30 minutes of
 * inactivity, and an error is exactly the kind of thing that arrives after a
 * long idle. A value captured at `init` would file it under a session that
 * ended.
 *
 * Values already on the event win. Only Argos writes these keys, so a caller
 * who set one did it deliberately.
 */
export function correlate<E extends CorrelatableEvent>(
  event: E,
  client: ArgosClient,
): E & CorrelatableEvent {
  const spine = client.correlation();

  event.tags = { ...spine, ...event.tags };

  // Sentry's own `user.id` is what ingest reads for the user column, so an app
  // that called `identify` should not also have to call `Sentry.setUser`.
  if (spine.argos_user_id !== undefined && event.user?.id === undefined) {
    event.user = { ...event.user, id: spine.argos_user_id };
  }

  return event;
}
