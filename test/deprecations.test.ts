import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgosClient } from '../src/client.js';
import { DeprecationCollector, matchPattern } from '../src/deprecations.js';
import { ArgosServer } from '../src/server/index.js';
import { close, flush, init } from '../src/index.js';
import type { EventBatch } from '../src/types.js';

const DSN = 'https://a1b2c3@ingest.argos.dev/42';

let fetchMock: ReturnType<typeof vi.fn>;

function sentEvents() {
  return fetchMock.mock.calls.flatMap((call) => {
    const url = call[0] as string;
    if (!url.includes('/events/')) return [];
    return (JSON.parse((call[1] as RequestInit).body as string) as EventBatch).events;
  });
}

/** Silences the console before a collector wraps it: the wrapper then calls
 * this spy as "the original", which is also how passthrough is asserted. */
function silenceConsole() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  close();
  vi.unstubAllGlobals();
});

describe('matchPattern', () => {
  it('fires on the phrases the wild sends', () => {
    expect(matchPattern('Fenced Frame API is deprecated and scheduled for removal.')).toBe(
      'deprecat',
    );
    expect(matchPattern('As of February 2025, DrawingManager will be removed.')).toBe(
      'will be removed',
    );
    expect(matchPattern('This endpoint is being sunset.')).toBe('sunset');
  });

  it('is case-insensitive and honours extra patterns', () => {
    expect(matchPattern('This Feature Is DEPRECATED')).toBe('deprecat');
    expect(matchPattern('canasta removed soon', ['canasta'])).toBe('canasta');
  });

  it('leaves ordinary warnings alone', () => {
    expect(matchPattern('disk usage at 90%')).toBeUndefined();
    expect(matchPattern('')).toBeUndefined();
  });
});

describe('the console capturero', () => {
  it('passes the console through untouched and reports a match once', () => {
    const quiet = silenceConsole();
    const emit = vi.fn();
    const collector = new DeprecationCollector(emit);
    collector.start();

    console.warn('Google Maps: DrawingManager is deprecated and will be removed.');
    console.warn('Google Maps: DrawingManager is deprecated and will be removed.');
    console.warn('disk usage at 90%');

    // The page's console keeps working exactly as before the wrap.
    expect(quiet).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ origin: 'console', pattern: 'deprecat' });
    expect((emit.mock.calls[0][0] as { message: string }).message).toContain('DrawingManager');

    collector.stop();
    quiet.mockRestore();
  });

  it('reports again in a fresh tab session', () => {
    const quiet = silenceConsole();
    const emit = vi.fn();
    const first = new DeprecationCollector(emit);
    first.start();
    console.warn('X is deprecated');
    first.stop();

    sessionStorage.clear();
    const second = new DeprecationCollector(emit);
    second.start();
    console.warn('X is deprecated');
    second.stop();
    quiet.mockRestore();

    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe('the ReportingObserver capturero', () => {
  it('maps the engine report onto the wire props', () => {
    const callbacks: Array<(reports: unknown[]) => void> = [];
    class FakeObserver {
      constructor(callback: (reports: unknown[]) => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ReportingObserver', FakeObserver);

    const emit = vi.fn();
    const collector = new DeprecationCollector(emit);
    collector.start();
    expect(callbacks.length).toBe(1);

    callbacks[0]([
      {
        type: 'deprecation',
        url: 'https://app.example.com/map',
        body: {
          id: 'FencedFrame',
          message: 'Fenced Frame API is deprecated and scheduled for removal.',
          sourceFile: 'https://app.example.com/bundle.js',
          lineNumber: 12,
          anticipatedRemoval: '2027-03-01T00:00:00.000Z',
        },
      },
      { type: 'deprecation', body: null },
      { type: 'intervention', body: { message: 'deprecated word, wrong type' } },
    ]);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toEqual({
      message: 'Fenced Frame API is deprecated and scheduled for removal.',
      origin: 'reporting-observer',
      url: 'https://app.example.com/map',
      feature: 'FencedFrame',
      source_file: 'https://app.example.com/bundle.js',
      line: 12,
      anticipate_removal: '2027-03-01',
    });
    collector.stop();
  });

  it('stays quiet where the API does not exist', () => {
    const collector = new DeprecationCollector(vi.fn());
    expect(() => {
      collector.start();
    }).not.toThrow();
    collector.stop();
  });
});

describe('the browser client wiring', () => {
  it('sends a captured warning as a deprecation event with the visit attached', async () => {
    const quiet = silenceConsole();
    init({ dsn: DSN, deprecations: true, heartbeat: false });

    console.warn('Google Maps JavaScript API: DrawingManager is deprecated.');
    await flush();
    close();
    quiet.mockRestore();

    const event = sentEvents().find((candidate) => candidate.kind === 'deprecation');
    expect(event).toMatchObject({
      kind: 'deprecation',
      name: 'deprecation',
      platform: 'browser',
      props: { origin: 'console', pattern: 'deprecat' },
    });
    // The spine a browser warning can carry is the point: it answers who the
    // removal will hit.
    if (event?.kind !== 'deprecation') throw new Error('expected a deprecation event');
    expect(event.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.anon_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('drops captured warnings while consent is pending', async () => {
    const quiet = silenceConsole();
    const client = new ArgosClient({ dsn: DSN, deprecations: true, requireConsent: true });

    console.warn('Something is deprecated.');
    await client.flush();
    client.close();
    quiet.mockRestore();

    expect(sentEvents().filter((candidate) => candidate.kind === 'deprecation')).toHaveLength(0);
  });
});

describe('the server capturero', () => {
  it('reports a DeprecationWarning without inventing a visit', async () => {
    const server = new ArgosServer({
      dsn: DSN,
      deprecations: true,
      heartbeat: false,
      release: 'api@2.0.0',
    });
    process.emit(
      'warning',
      Object.assign(new Error('The url.parse() API is deprecated.'), {
        name: 'DeprecationWarning',
        code: 'DEP0025',
      }),
    );
    await server.flush();

    const event = sentEvents().find((candidate) => candidate.kind === 'deprecation');
    expect(event).toMatchObject({
      kind: 'deprecation',
      name: 'deprecation',
      platform: 'server',
      release: 'api@2.0.0',
      props: {
        origin: 'server',
        feature: 'DEP0025',
        message: 'The url.parse() API is deprecated.',
      },
    });
    if (event?.kind !== 'deprecation') throw new Error('expected a deprecation event');
    expect(event.session_id).toBeUndefined();
    expect(event.anon_id).toBeUndefined();
  });

  it('ignores the runtime warnings that are not deprecations', async () => {
    const server = new ArgosServer({ dsn: DSN, deprecations: true, heartbeat: false });
    process.emit(
      'warning',
      Object.assign(new Error('Possible memory leak'), { name: 'MaxListenersExceededWarning' }),
    );
    await server.flush();

    expect(sentEvents().filter((candidate) => candidate.kind === 'deprecation')).toHaveLength(0);
  });
});
