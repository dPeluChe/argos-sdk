// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { initServer } from '../src/server/index.js';

afterEach(async () => {
  await Sentry.close();
  delete (globalThis as { __SENTRY__?: unknown }).__SENTRY__;
});

it('reports @sentry/node 11 from the global carrier, without importing it', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  Sentry.init({ dsn: 'https://key@sentry.example.com/1', defaultIntegrations: false });

  initServer({ dsn: 'https://key@ingest.example.com/42' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  expect(body.runtime).toBe('node');
  expect(body.sentry).toEqual({ name: 'sentry.javascript.node', version: '11.0.0' });
});
