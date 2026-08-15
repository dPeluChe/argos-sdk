import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, argosBeforeSend, close, identify, init } from '../src/index.js';

const DSN = 'https://a1b2c3@ingest.argos.dev/42';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
});

afterEach(() => {
  close();
  vi.unstubAllGlobals();
});

describe('the tag keys ingest reads', () => {
  // These four strings are a wire contract with internal/envelope/correlate.go.
  // Renaming one here silently stops correlating errors, and nothing else fails.
  it('are exactly the ones the Go side lifts', () => {
    init({ dsn: DSN });
    identify('user-7');
    account('acct-3');

    const event = argosBeforeSend({});

    expect(Object.keys(event.tags ?? {}).sort()).toEqual([
      'argos_account_id',
      'argos_anon_id',
      'argos_session_id',
      'argos_user_id',
    ]);
  });

  it('omits the optional two rather than sending undefined', () => {
    init({ dsn: DSN });

    const tags = argosBeforeSend({}).tags ?? {};

    expect(Object.keys(tags).sort()).toEqual(['argos_anon_id', 'argos_session_id']);
    expect('argos_user_id' in tags).toBe(false);
  });

  it('carries the same session the product events carry', () => {
    const client = init({ dsn: DSN });

    expect(argosBeforeSend({}).tags?.argos_session_id).toBe(client?.correlation().argos_session_id);
  });
});

describe('what it must never do to the host application', () => {
  it('returns the event when Argos was never started', () => {
    const event = { message: 'boom' };

    expect(argosBeforeSend(event)).toBe(event);
  });

  it('returns the event after close, rather than discarding the error', () => {
    init({ dsn: DSN });
    close();

    expect(argosBeforeSend({ message: 'boom' }).message).toBe('boom');
  });

  it('leaves tags the caller already set alone', () => {
    init({ dsn: DSN });

    const event = argosBeforeSend({ tags: { argos_session_id: 'mine', release: '1.0' } });

    expect(event.tags).toMatchObject({ argos_session_id: 'mine', release: '1.0' });
  });

  it('does not overwrite a user the caller set through Sentry', () => {
    init({ dsn: DSN });
    identify('argos-user');

    expect(argosBeforeSend({ user: { id: 'sentry-user' } }).user.id).toBe('sentry-user');
  });
});

describe('the user', () => {
  it('is stamped so identify() alone is enough', () => {
    init({ dsn: DSN });
    identify('user-7');

    expect(argosBeforeSend({}).user?.id).toBe('user-7');
  });

  it('is left absent when nobody has been identified', () => {
    init({ dsn: DSN });

    expect(argosBeforeSend({}).user).toBeUndefined();
  });
});

describe('a renewed session', () => {
  // The reason this is read per event and not captured once at init.
  it('is picked up by the next error, not the one from init', () => {
    init({ dsn: DSN });
    const first = argosBeforeSend({}).tags?.argos_session_id;

    close();
    sessionStorage.clear();
    init({ dsn: DSN });

    expect(argosBeforeSend({}).tags?.argos_session_id).not.toBe(first);
  });
});
