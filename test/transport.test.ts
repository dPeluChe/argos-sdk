import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transport, type TransportConfig } from '../src/transport.js';
import type { ArgosEvent, EventBatch } from '../src/types.js';

const URL_ = 'https://ingest.argos.dev/api/42/events/';

function config(overrides: Partial<TransportConfig> = {}): TransportConfig {
  return {
    url: URL_,
    publicKey: 'a'.repeat(32),
    flushIntervalMs: 5_000,
    maxBatchSize: 50,
    maxBufferSize: 1_000,
    ...overrides,
  };
}

let counter = 0;
function event(name = 'click'): ArgosEvent {
  counter += 1;
  return {
    event_id: `event-${String(counter)}`,
    event_time: '2026-08-10T07:12:30.102Z',
    kind: 'product',
    name,
    session_id: '0192f3a7-1c2e-7c31-9a1e-6f0b8c2d4e5a',
    anon_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    span_id: '00f067aa0ba902b7',
    platform: 'browser',
  };
}

function bodyOf(call: unknown[]): EventBatch {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as EventBatch;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  counter = 0;
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('buffering', () => {
  it('holds events until something asks for a flush', () => {
    const transport = new Transport(config());
    transport.enqueue(event());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transport.pending).toBe(1);
  });

  it('sends nothing when the buffer is empty', async () => {
    await new Transport(config()).flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flushes as soon as the batch reaches maxBatchSize', async () => {
    const transport = new Transport(config({ maxBatchSize: 3 }));
    transport.enqueue(event());
    transport.enqueue(event());
    expect(fetchMock).not.toHaveBeenCalled();
    transport.enqueue(event());
    await transport.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]).events).toHaveLength(3);
  });

  it('flushes on the timer', async () => {
    vi.useFakeTimers();
    const transport = new Transport(config({ flushIntervalMs: 5_000 }));
    transport.start();
    transport.enqueue(event());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    transport.stop();
  });

  it('stops the timer on stop', async () => {
    vi.useFakeTimers();
    const transport = new Transport(config());
    transport.start();
    transport.stop();
    transport.enqueue(event());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drains a backlog in maxBatchSize chunks', async () => {
    const transport = new Transport(config({ maxBatchSize: 2 }));
    for (let i = 0; i < 5; i++) transport.enqueue(event());
    await transport.flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchMock.mock.calls[2]).events).toHaveLength(1);
  });
});

describe('the request', () => {
  it('carries the key in a header and the contract-shaped body', async () => {
    const transport = new Transport(config());
    transport.enqueue(event('pageview'));
    await transport.flush();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Argos-Key': 'a'.repeat(32),
    });
    const batch = bodyOf(fetchMock.mock.calls[0]);
    expect(batch.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(batch.events[0]?.name).toBe('pageview');
  });
});

describe('the buffer cap', () => {
  it('drops the oldest event and counts it', () => {
    const transport = new Transport(config({ maxBufferSize: 3, maxBatchSize: 100 }));
    for (let i = 0; i < 5; i++) transport.enqueue(event());
    expect(transport.pending).toBe(3);
    expect(transport.dropped).toBe(2);
  });

  it('reports the running drop count on the event that overflowed', () => {
    const transport = new Transport(config({ maxBufferSize: 1, maxBatchSize: 100 }));
    const first = event();
    const second = event();
    transport.enqueue(first);
    transport.enqueue(second);
    expect(first.props).toBeUndefined();
    expect(second.props).toEqual({ 'argos.dropped_events': 1 });
  });

  it('keeps the newest events, which are the ones still worth sending', async () => {
    const transport = new Transport(config({ maxBufferSize: 2, maxBatchSize: 100 }));
    transport.enqueue(event());
    transport.enqueue(event());
    transport.enqueue(event());
    await transport.flush();
    const ids = bodyOf(fetchMock.mock.calls[0]).events.map((e) => e.event_id);
    expect(ids).toEqual(['event-2', 'event-3']);
  });
});

describe('the unload flush', () => {
  it('uses sendBeacon with the key in the query string', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const transport = new Transport(config());
    transport.enqueue(event());
    transport.flushOnUnload();

    expect(fetchMock).not.toHaveBeenCalled();
    const [url, blob] = sendBeacon.mock.calls[0] as [string, Blob];
    expect(url).toBe(`${URL_}?argos_key=${'a'.repeat(32)}`);
    expect(blob.type).toBe('application/json');
  });

  it('falls back to a keepalive fetch when sendBeacon refuses the payload', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) });
    const transport = new Transport(config());
    transport.enqueue(event());
    transport.flushOnUnload();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a keepalive fetch when sendBeacon does not exist', () => {
    vi.stubGlobal('navigator', {});
    const transport = new Transport(config());
    transport.enqueue(event());
    transport.flushOnUnload();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the whole buffer in one beacon, not just one batch', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const transport = new Transport(config({ maxBatchSize: 100 }));
    for (let i = 0; i < 60; i++) transport.enqueue(event());
    transport.flushOnUnload();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(transport.pending).toBe(0);
  });

  it('does nothing when there is nothing buffered', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    new Transport(config()).flushOnUnload();
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

describe('the flush timer', () => {
  it('unrefs the interval so a Node process can still exit', () => {
    const unref = vi.fn();
    const handle = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle);
    const transport = new Transport(config());
    transport.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    transport.stop();
  });

  it('accepts a browser handle, which is a number with no unref', () => {
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      7 as unknown as ReturnType<typeof setInterval>,
    );
    const transport = new Transport(config());
    expect(() => {
      transport.start();
    }).not.toThrow();
    transport.stop();
  });
});
