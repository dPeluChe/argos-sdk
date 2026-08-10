import { describe, expect, it } from 'vitest';
import { eventsUrl, identifyUrl, parseDsn, resolveEndpoint } from '../src/dsn.js';

describe('parseDsn', () => {
  it('parses the Sentry DSN anatomy', () => {
    expect(parseDsn('https://a1b2c3@ingest.argos.dev/42')).toEqual({
      baseUrl: 'https://ingest.argos.dev',
      projectId: '42',
      publicKey: 'a1b2c3',
    });
  });

  it('keeps a path prefix and a port', () => {
    expect(parseDsn('http://key@localhost:8080/argos/ingest/7')).toEqual({
      baseUrl: 'http://localhost:8080/argos/ingest',
      projectId: '7',
      publicKey: 'key',
    });
  });

  it('ignores the legacy secret half of the key pair', () => {
    expect(parseDsn('https://public:secret@ingest.argos.dev/42').publicKey).toBe('public');
  });

  it.each([
    ['not a url', 'nonsense'],
    ['no public key', 'https://ingest.argos.dev/42'],
    ['no project id', 'https://key@ingest.argos.dev'],
    ['wrong protocol', 'ftp://key@ingest.argos.dev/42'],
  ])('rejects a DSN with %s', (_reason, dsn) => {
    expect(() => parseDsn(dsn)).toThrow(/argos:/);
  });
});

describe('resolveEndpoint', () => {
  it('accepts the explicit form and trims trailing slashes off the host', () => {
    expect(
      resolveEndpoint({ projectId: '42', publicKey: 'key', host: 'https://ingest.argos.dev/' }),
    ).toEqual({ baseUrl: 'https://ingest.argos.dev', projectId: '42', publicKey: 'key' });
  });

  it('prefers the dsn when both forms are given', () => {
    const endpoint = resolveEndpoint({
      dsn: 'https://fromdsn@ingest.argos.dev/1',
      projectId: '42',
      publicKey: 'explicit',
      host: 'https://other.dev',
    });
    expect(endpoint.publicKey).toBe('fromdsn');
  });

  it('rejects a half-filled explicit form', () => {
    expect(() => resolveEndpoint({ projectId: '42' })).toThrow(/dsn or projectId/);
  });
});

describe('endpoint urls', () => {
  const endpoint = parseDsn('https://key@ingest.argos.dev/42');

  it('matches the wire contract paths', () => {
    expect(eventsUrl(endpoint)).toBe('https://ingest.argos.dev/api/42/events/');
    expect(identifyUrl(endpoint)).toBe('https://ingest.argos.dev/api/42/identify/');
  });
});
