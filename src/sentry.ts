import type { ArgosClient } from './client.js';

/**
 * The shape this needs off a Sentry event, declared structurally so no Sentry
 * package is imported. Keeping zero runtime dependencies is the reason; the
 * happy side effect is that this works against every Sentry SDK major, since
 * `tags` and `user.id` have not changed across any of them.
 *
 * No index signature: Sentry's `ErrorEvent` is an interface without one, and
 * would not be assignable. `| undefined` keeps `exactOptionalPropertyTypes` hosts happy.
 */
export interface CorrelatableEvent {
  tags?: Record<string, unknown> | undefined;
  user?: { id?: string | number | undefined } | undefined;
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
 *
 * `& object` sidesteps the weak-type check, so an event with neither key still passes.
 */
export function correlate<E extends CorrelatableEvent & object>(
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
