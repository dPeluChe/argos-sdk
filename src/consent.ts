import type { KeyValueStore } from './storage.js';

const DECISION = 'argos.consent';

export type ConsentState = 'granted' | 'denied' | 'unknown';

/**
 * Whether this visitor has agreed to be measured.
 *
 * Off by default (`requireConsent: false`), so an install that does not need a
 * gate keeps working exactly as before and nobody's data quietly stops
 * arriving after an upgrade. Turned on, nothing is stored and nothing is sent
 * until consent is granted — not buffered until then, **dropped**: holding
 * events collected before a yes and releasing them after it is still having
 * collected them before the yes.
 *
 * The decision itself is stored. A gate that forgets is a gate that asks on
 * every page, and the answer to that is always the banner everyone clicks away.
 */
export class Consent {
  constructor(
    private readonly store: KeyValueStore,
    private readonly required: boolean,
  ) {}

  state(): ConsentState {
    const stored = this.store.get(DECISION);
    if (stored === 'granted' || stored === 'denied') return stored;
    return 'unknown';
  }

  /** True when the SDK may store an identity and send an event. */
  allowed(): boolean {
    if (!this.required) return this.state() !== 'denied';
    return this.state() === 'granted';
  }

  grant(): void {
    this.store.set(DECISION, 'granted');
  }

  /**
   * A refusal outranks everything, including an install that does not require
   * consent: a visitor who has said no has said no, and a later page that
   * simply forgot to switch the gate on must not read as a fresh yes. This is
   * the one direction that must be sticky, which is why `allowed()` checks for
   * `denied` even when consent is not required.
   */
  revoke(): void {
    this.store.set(DECISION, 'denied');
  }
}
