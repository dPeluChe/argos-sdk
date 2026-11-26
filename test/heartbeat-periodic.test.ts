// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DSN = 'https://0123456789abcdef0123456789abcdef@ingest.example.com/42';

let fetchMock: ReturnType<typeof vi.fn>;

// The per-process guard is module state, so each test gets fresh modules.
const server = () => import('../src/server/index.js');

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const beats = () => fetchMock.mock.calls.length;

describe('periodic heartbeat', () => {
  it('beats on the configured interval, not only at startup', async () => {
    const { initServer } = await server();
    const instance = initServer({ dsn: DSN, heartbeatInterval: 1000 });
    await vi.advanceTimersByTimeAsync(1);
    expect(beats()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    // Jitter is ±10%, so ten seconds hold nine to eleven periodic beats.
    expect(beats()).toBeGreaterThanOrEqual(10);
    expect(beats()).toBeLessThanOrEqual(12);
    instance.close();
  });

  it('uses a minute by default', async () => {
    const { initServer } = await server();
    const instance = initServer({ dsn: DSN });
    await vi.advanceTimersByTimeAsync(1);
    expect(beats()).toBe(1);

    // The first repeat lands between 54 and 66 seconds.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(beats()).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(beats()).toBe(2);
    instance.close();
  });

  it('stops beating after close', async () => {
    const { initServer } = await server();
    const instance = initServer({ dsn: DSN, heartbeatInterval: 1000 });
    await vi.advanceTimersByTimeAsync(1);
    const before = beats();

    instance.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(beats()).toBe(before);
  });

  it('keeps only the startup beat with heartbeatInterval: false', async () => {
    const { initServer } = await server();
    const instance = initServer({ dsn: DSN, heartbeatInterval: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(beats()).toBe(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(beats()).toBe(1);
    instance.close();
  });

  it('sends nothing with heartbeat: false', async () => {
    const { initServer } = await server();
    initServer({ dsn: DSN, heartbeat: false, heartbeatInterval: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(beats()).toBe(0);
  });

  it('keeps one beat per process when two servers are built', async () => {
    const { initServer } = await server();
    const first = initServer({ dsn: DSN, heartbeatInterval: 1000 });
    initServer({ dsn: DSN, heartbeatInterval: 1000 });

    await vi.advanceTimersByTimeAsync(5_000);
    // One owner, so five seconds of beats, not ten.
    expect(beats()).toBeGreaterThanOrEqual(5);
    expect(beats()).toBeLessThanOrEqual(7);
    first.close();
  });
});
