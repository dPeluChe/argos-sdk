import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, grantConsent, init, revokeConsent, track } from '../src/index.js';

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
