import { beforeEach, describe, expect, it } from 'vitest';
import { Identity, SESSION_IDLE_MS } from '../src/session.js';
import { createStore, memoryStore, type KeyValueStore } from '../src/storage.js';

let clock = 1_760_000_000_000;
const now = (): number => clock;

let local: KeyValueStore;
let session: KeyValueStore;

beforeEach(() => {
  clock = 1_760_000_000_000;
  local = memoryStore();
  session = memoryStore();
});

describe('anon_id', () => {
  it('is a v4 uuid minted once and reused', () => {
    const identity = new Identity(local, session, now);
    const first = identity.anonId();
    expect(first[14]).toBe('4');
    expect(identity.anonId()).toBe(first);
  });

  it('survives a client rebuilt on the next page', () => {
    const first = new Identity(local, session, now).anonId();
    expect(new Identity(local, session, now).anonId()).toBe(first);
  });
});

describe('session_id', () => {
  it('is a v7 uuid shared across page navigations', () => {
    const first = new Identity(local, session, now).sessionId();
    expect(first[14]).toBe('7');
    expect(new Identity(local, session, now).sessionId()).toBe(first);
  });

  it('keeps the same session one millisecond before the idle boundary', () => {
    const identity = new Identity(local, session, now);
    const first = identity.sessionId();
    clock += SESSION_IDLE_MS - 1;
    expect(identity.sessionId()).toBe(first);
  });

  it('renews exactly at the 30 minute boundary', () => {
    const identity = new Identity(local, session, now);
    const first = identity.sessionId();
    clock += SESSION_IDLE_MS;
    const second = identity.sessionId();
    expect(second).not.toBe(first);
    expect(second > first).toBe(true);
  });

  it('treats every read as activity, so a slow but steady visit is one session', () => {
    const identity = new Identity(local, session, now);
    const first = identity.sessionId();
    for (let i = 0; i < 10; i++) {
      clock += SESSION_IDLE_MS - 1_000;
      expect(identity.sessionId()).toBe(first);
    }
  });

  it('starts a fresh session when the store lost the seen-at stamp', () => {
    const identity = new Identity(local, session, now);
    const first = identity.sessionId();
    session.set('argos.session_seen_at', 'not-a-number');
    expect(identity.sessionId()).not.toBe(first);
  });

  it('works with the in-memory fallback when storage is unavailable', () => {
    const identity = new Identity(createStore('localStorage'), memoryStore(), now);
    const first = identity.sessionId();
    expect(identity.sessionId()).toBe(first);
    clock += SESSION_IDLE_MS;
    expect(identity.sessionId()).not.toBe(first);
  });
});

describe('user_id', () => {
  it('is undefined until identify and persists after it', () => {
    const identity = new Identity(local, session, now);
    expect(identity.userId()).toBeUndefined();
    identity.setUserId('user_8871');
    expect(new Identity(local, session, now).userId()).toBe('user_8871');
  });
});
