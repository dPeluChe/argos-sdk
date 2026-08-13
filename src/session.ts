import { uuidv4, uuidv7 } from './ids.js';
import type { KeyValueStore } from './storage.js';

export const SESSION_IDLE_MS = 30 * 60 * 1000;

const ANON_ID = 'argos.anon_id';
const SESSION_ID = 'argos.session_id';
const SEEN_AT = 'argos.session_seen_at';
const USER_ID = 'argos.user_id';
const ACCOUNT_ID = 'argos.account_id';
const ENTRY_SENT = 'argos.entry_sent';

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

  /**
   * True for the first caller of each visit, false after. Keyed by session id,
   * so a session renewed past the idle window is a new entry.
   */
  claimEntry(): boolean {
    const sessionId = this.sessionId();
    if (this.session.get(ENTRY_SENT) === sessionId) return false;
    this.session.set(ENTRY_SENT, sessionId);
    return true;
  }

  userId(): string | undefined {
    return this.local.get(USER_ID) ?? undefined;
  }

  setUserId(userId: string): void {
    this.local.set(USER_ID, userId);
  }

  accountId(): string | undefined {
    return this.local.get(ACCOUNT_ID) ?? undefined;
  }

  setAccount(accountId: string): void {
    this.local.set(ACCOUNT_ID, accountId);
  }

  /**
   * Signing out forgets the person and the tenant, and keeps the anon id: that
   * one is about this device, and clearing it would count the same browser as a
   * new visitor every time somebody logs out.
   */
  clearUser(): void {
    this.local.remove(USER_ID);
    this.local.remove(ACCOUNT_ID);
  }
}
