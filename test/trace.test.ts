import { describe, expect, it } from 'vitest';
import { baggage, newTrace, traceparent } from '../src/trace.js';

describe('traceparent', () => {
  it('matches the W3C format from the wire contract', () => {
    const header = traceparent({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
    expect(header).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('produces a header the W3C regex accepts for freshly minted ids', () => {
    expect(traceparent(newTrace())).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe('baggage', () => {
  it('emits the pair the wire contract shows', () => {
    expect(
      baggage({
        'argos.session_id': '0192f3a7-1c2e-7c31-9a1e-6f0b8c2d4e5a',
        'argos.anon_id': '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      }),
    ).toBe(
      'argos.session_id=0192f3a7-1c2e-7c31-9a1e-6f0b8c2d4e5a,argos.anon_id=3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    );
  });

  it('percent-encodes the characters the baggage grammar forbids', () => {
    const header = baggage({ k: 'a,b;c d"e\\f' });
    expect(header).toBe('k=a%2Cb%3Bc%20d%22e%5Cf');
    expect(header).not.toMatch(/[,;\s"\\]/);
  });

  it('percent-encodes non-ascii as utf-8', () => {
    expect(baggage({ k: 'año' })).toBe('k=a%C3%B1o');
  });

  it('drops empty and undefined values instead of emitting a bare key', () => {
    expect(baggage({ a: '1', b: undefined, c: '' })).toBe('a=1');
  });

  it('returns an empty string when nothing is known', () => {
    expect(baggage({})).toBe('');
  });
});
