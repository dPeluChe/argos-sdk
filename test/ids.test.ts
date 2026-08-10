import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSpanId, newTraceId, uuidv4 } from '../src/ids.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function timestampOf(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

describe('uuidv4', () => {
  it('has the v4 version and RFC 9562 variant bits', () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv4();
      expect(id).toMatch(UUID);
      expect(id[14]).toBe('4');
      expect('89ab').toContain(id[19]);
    }
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, uuidv4));
    expect(ids.size).toBe(2000);
  });
});

describe('uuidv7', () => {
  // The monotonic counter is module state, so every case starts from a clean module.
  let mint: () => string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    vi.resetModules();
    mint = (await import('../src/ids.js')).uuidv7;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has the v7 version and RFC 9562 variant bits', () => {
    const id = mint();
    expect(id).toMatch(UUID);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });

  it('encodes the current unix millisecond in the leading 48 bits', () => {
    vi.setSystemTime(new Date('2026-08-10T07:12:30.102Z'));
    expect(timestampOf(mint())).toBe(Date.now());
  });

  it('is strictly monotonic inside a single frozen millisecond', () => {
    const ids = Array.from({ length: 5000 }, mint);
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true);
  });

  it('rolls into the next millisecond when the 12-bit counter overflows', () => {
    const ids = Array.from({ length: 5000 }, mint);
    expect(timestampOf(ids.at(-1)!)).toBeGreaterThan(timestampOf(ids[0]));
  });

  it('stays monotonic when the clock jumps backwards', () => {
    vi.setSystemTime(1_760_000_010_000);
    const before = mint();
    vi.setSystemTime(1_760_000_000_000);
    const after = mint();
    expect(after > before).toBe(true);
  });

  it('sorts lexicographically in creation order across milliseconds', () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(mint());
      vi.advanceTimersByTime(3);
    }
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('trace ids', () => {
  it('produces 32 and 16 lowercase hex characters', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
