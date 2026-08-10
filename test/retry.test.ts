import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliver, MAX_ATTEMPTS, planRetry, retryAfterMs } from '../src/transport.js';

const URL_ = 'https://ingest.argos.dev/api/42/events/';
const noJitter = (): number => 1;

function ok(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('planRetry', () => {
  it.each([400, 401, 403, 404, 413, 422])('never retries %i', (status) => {
    expect(planRetry({ status, retryAfter: null }, 0).retry).toBe(false);
  });

  it.each([500, 502, 503, 504])('retries %i', (status) => {
    expect(planRetry({ status, retryAfter: null }, 0).retry).toBe(true);
  });

  it('retries a network error, which has no status at all', () => {
    expect(planRetry({ status: null, retryAfter: null }, 0).retry).toBe(true);
  });

  it('does not retry a success', () => {
    expect(planRetry({ status: 202, retryAfter: null }, 0).retry).toBe(false);
  });

  it('doubles the delay per attempt and caps it', () => {
    const delays = [0, 1, 2, 3].map(
      (attempt) => planRetry({ status: 503, retryAfter: null }, attempt, noJitter).delayMs,
    );
    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });

  it('stops after MAX_ATTEMPTS sends', () => {
    expect(planRetry({ status: 503, retryAfter: null }, MAX_ATTEMPTS - 2).retry).toBe(true);
    expect(planRetry({ status: 503, retryAfter: null }, MAX_ATTEMPTS - 1).retry).toBe(false);
  });

  it('jitters within half the backoff window', () => {
    const low = planRetry({ status: 503, retryAfter: null }, 2, () => 0).delayMs;
    const high = planRetry({ status: 503, retryAfter: null }, 2, () => 1).delayMs;
    expect(low).toBe(1000);
    expect(high).toBe(2000);
  });

  it('honors Retry-After on 429 instead of the backoff', () => {
    expect(planRetry({ status: 429, retryAfter: '7' }, 0).delayMs).toBe(7000);
  });

  it('falls back to the backoff when a 429 carries no Retry-After', () => {
    expect(planRetry({ status: 429, retryAfter: null }, 0, noJitter).delayMs).toBe(500);
  });

  it('ignores Retry-After on a 5xx, where it is not part of the contract', () => {
    expect(planRetry({ status: 503, retryAfter: '600' }, 0, noJitter).delayMs).toBe(500);
  });
});

describe('retryAfterMs', () => {
  it('reads delay-seconds', () => {
    expect(retryAfterMs('12')).toBe(12000);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-08-10T07:00:00Z');
    expect(retryAfterMs('Mon, 10 Aug 2026 07:00:30 GMT', now)).toBe(30_000);
  });

  it('clamps a date already in the past to zero', () => {
    const now = Date.parse('2026-08-10T07:00:00Z');
    expect(retryAfterMs('Mon, 10 Aug 2026 06:59:00 GMT', now)).toBe(0);
  });

  it.each([null, undefined, '', 'soon'])('returns null for %s', (header) => {
    expect(retryAfterMs(header)).toBeNull();
  });
});

describe('deliver', () => {
  it('sends once on 202', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(202));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deliver(URL_, 'key', '{}')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 403, 413])('gives up immediately on %i', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(ok(status));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deliver(URL_, 'key', '{}')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 and reports success once it clears', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok(503))
      .mockResolvedValueOnce(ok(503))
      .mockResolvedValueOnce(ok(202));
    vi.stubGlobal('fetch', fetchMock);
    const sent = deliver(URL_, 'key', '{}');
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(sent).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a rejected fetch, which is how the browser reports offline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok(202));
    vi.stubGlobal('fetch', fetchMock);
    const sent = deliver(URL_, 'key', '{}');
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(sent).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after MAX_ATTEMPTS sends instead of looping forever', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(ok(500));
    vi.stubGlobal('fetch', fetchMock);
    const sent = deliver(URL_, 'key', '{}');
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(sent).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('waits out the Retry-After window on a 429', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok(429, { 'Retry-After': '60' }))
      .mockResolvedValueOnce(ok(202));
    vi.stubGlobal('fetch', fetchMock);
    const sent = deliver(URL_, 'key', '{}');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(sent).resolves.toBe(true);
  });
});
