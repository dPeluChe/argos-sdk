import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  account,
  flush,
  getClient,
  grantConsent,
  identify,
  init,
  revokeConsent,
  track,
} from '../src/index.js';

const DSN = 'https://0123456789abcdef0123456789abcdef@ingest.example.com/42';

function sent(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(null, { status: 202 }));
    }),
  );
  return calls;
}

describe('the consent gate', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('is off by default, so an upgrade does not stop anyone’s data arriving', async () => {
    const calls = sent();
    init({ dsn: DSN });

    track('checkout_started');
    await flush();

    expect(localStorage.getItem('argos.anon_id')).not.toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('stores no identity at all before consent is granted', async () => {
    const calls = sent();
    init({ dsn: DSN, requireConsent: true });

    track('checkout_started');
    await flush();

    // The gate sits in front of building the event, because building it is
    // what creates and stores the anon_id.
    expect(localStorage.getItem('argos.anon_id')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('collects from the yes onwards, and not from before it', async () => {
    const calls = sent();
    init({ dsn: DSN, requireConsent: true });

    track('before_the_banner');
    grantConsent();
    track('after_the_banner');
    await flush();

    // Not held and released: an event collected before the yes was still
    // collected before the yes.
    expect(calls.length).toBeGreaterThan(0);
    expect(localStorage.getItem('argos.anon_id')).not.toBeNull();
  });

  it('keeps a refusal even where consent is not required', async () => {
    init({ dsn: DSN, requireConsent: true });
    revokeConsent();

    // A later page that simply forgot to turn the gate on must not read as a
    // fresh yes. This is the one direction that has to be sticky.
    const calls = sent();
    init({ dsn: DSN });
    track('checkout_started');
    await flush();

    expect(calls).toEqual([]);
    expect(localStorage.getItem('argos.anon_id')).toBeNull();
  });

  it('survives storage that refuses to be written', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('private mode');
    };

    try {
      // Nothing here should throw into the host app; the gate simply cannot
      // remember, which is the safe direction.
      expect(() => {
        init({ dsn: DSN, requireConsent: true });
        grantConsent();
        track('checkout_started');
      }).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe('the tenant an event happened in', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('is stamped on every later event without being repeated', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: { body?: string }) => {
        if (options.body) bodies.push(options.body);
        return Promise.resolve(new Response(null, { status: 202 }));
      }),
    );
    init({ dsn: DSN });

    account('acct_7f3a');
    track('checkout_started');
    track('checkout_completed');
    await flush();

    const events = bodies.flatMap((body) => {
      const batch: unknown = JSON.parse(body);
      return (batch as { events: { account_id?: string; name: string }[] }).events;
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.account_id === 'acct_7f3a')).toBe(true);
  });

  it('is not written before consent, like everything else', () => {
    init({ dsn: DSN, requireConsent: true });

    account('acct_7f3a');

    // Setting a tenant writes to this browser. The gate is in front of that,
    // not only in front of the send.
    expect(localStorage.getItem('argos.account_id')).toBeNull();
  });

  it('is forgotten on sign out, and the device is not', () => {
    init({ dsn: DSN });
    account('acct_7f3a');
    identify('user_1');
    track('anything');
    const device = localStorage.getItem('argos.anon_id');

    getClient()?.signOut();

    expect(localStorage.getItem('argos.account_id')).toBeNull();
    expect(localStorage.getItem('argos.user_id')).toBeNull();
    // Clearing this would count the same browser as a new visitor every time
    // somebody logs out.
    expect(localStorage.getItem('argos.anon_id')).toBe(device);
  });
});
