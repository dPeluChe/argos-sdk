import { uuidv4, uuidv7 } from './ids.js';
import type { KeyValueStore } from './storage.js';

export const SESSION_IDLE_MS = 30 * 60 * 1000;

const ANON_ID = 'argos.anon_id';
const SESSION_ID = 'argos.session_id';
const SEEN_AT = 'argos.session_seen_at';
const USER_ID = 'argos.user_id';

/**
 * `anon_id` lives in localStorage (one device), `session_id` in sessionStorage
 * (one visit). Both are read through the stores, so a page navigation that
 * rebuilds the client still lands on the same ids.
 */
export class Identity {
  constructor(
    private readonly local: KeyValueStore,
    private readonly session: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  anonId(): string {
    let id = this.local.get(ANON_ID);
    if (!id) {
      id = uuidv4();
      this.local.set(ANON_ID, id);
    }
    return id;
  }

  /** Reading the session id *is* the activity signal: it renews and re-arms the idle window. */
  sessionId(): string {
    const at = this.now();
    const seenAt = Number(this.session.get(SEEN_AT));
    const idle = !Number.isFinite(seenAt) || at - seenAt >= SESSION_IDLE_MS;
    let id = this.session.get(SESSION_ID);
    if (!id || idle) {
      id = uuidv7();
      this.session.set(SESSION_ID, id);
    }
    this.session.set(SEEN_AT, String(at));
    return id;
  }

  userId(): string | undefined {
    return this.local.get(USER_ID) ?? undefined;
  }

  setUserId(userId: string): void {
    this.local.set(USER_ID, userId);
  }
}
