import type { InitOptions } from './types.js';

export interface Endpoint {
  baseUrl: string;
  projectId: string;
  publicKey: string;
}

const DSN_SHAPE = '{protocol}://{publicKey}@{host}[/{path}]/{projectId}';

/** Sentry DSN anatomy, so the same string keeps working for the Envelope endpoint in Stage 2. */
export function parseDsn(dsn: string): Endpoint {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`argos: DSN is not a URL, expected ${DSN_SHAPE}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`argos: DSN protocol must be http or https, got ${url.protocol}`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const projectId = segments.pop() ?? '';
  const publicKey = url.username;
  if (!publicKey || !projectId) {
    throw new Error(`argos: DSN must look like ${DSN_SHAPE}`);
  }

  const prefix = segments.length ? `/${segments.join('/')}` : '';
  return { baseUrl: `${url.protocol}//${url.host}${prefix}`, projectId, publicKey };
}

export function resolveEndpoint(options: InitOptions): Endpoint {
  if (options.dsn) return parseDsn(options.dsn);
  const { projectId, publicKey, host } = options;
  if (!projectId || !publicKey || !host) {
    throw new Error('argos: init needs either a dsn or projectId + publicKey + host');
  }
  return { baseUrl: host.replace(/\/+$/, ''), projectId, publicKey };
}

export function eventsUrl(endpoint: Endpoint): string {
  return `${endpoint.baseUrl}/api/${endpoint.projectId}/events/`;
}

export function identifyUrl(endpoint: Endpoint): string {
  return `${endpoint.baseUrl}/api/${endpoint.projectId}/identify/`;
}
