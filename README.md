# argos-sdk

Product event and correlation SDKs for [Argos](../docs/ARGOS_SPEC.md).

This repo currently holds one package, `@argos/browser` (Stage 1). Node and
Python SDKs land later and will move this into a workspace — see
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## What it is

The browser SDK produces **product events** — pageviews, clicks, anything the
app names — and carries the correlation spine that ties them to backend errors
and agent runs: `session_id`, `anon_id`, `user_id`, `trace_id`.

It does **not** capture errors. Point any existing Sentry SDK at Argos for
that; it speaks the same protocol. This package adds what no standard covers.

Zero runtime dependencies. UUIDv7, W3C Trace Context and W3C Baggage are
implemented here rather than pulled in.

## Install

```bash
npm install @argos/browser
```

## Quick start

```ts
import { init, track, identify, pageview, instrumentFetch } from '@argos/browser';

init({
  dsn: 'https://a1b2c3d4e5f6@ingest.argos.dev/42',
  environment: 'production',
  release: 'web@2026.8.1',
});

pageview();
track('checkout_started', { plan: 'pro' });
identify('user_8871');

// Attach traceparent + baggage to same-origin requests, so backend events
// land in the same session.
instrumentFetch();
```

The DSN follows Sentry's anatomy, so one string works for both this SDK and a
Sentry SDK pointed at Argos. The explicit form is equivalent:

```ts
init({ projectId: '42', publicKey: 'a1b2c3d4e5f6', host: 'https://ingest.argos.dev' });
```

## API

| Function                    | What it does                                                              |
| --------------------------- | ------------------------------------------------------------------------- |
| `init(options)`             | Creates the client, starts the flush timer, returns it                    |
| `track(name, props?)`       | Queues a product event                                                    |
| `pageview(path?)`           | `track('pageview', …)` with attribution; defaults to `location.pathname`  |
| `identify(userId)`          | Writes the `anon_id → user_id` alias and stamps `user_id` on later events |
| `flush()`                   | Sends everything buffered; resolves when the queue drains                 |
| `traceHeaders()`            | `{ traceparent, baggage }` for one outbound request                       |
| `instrumentFetch(options?)` | Wraps `window.fetch` to attach those headers; returns the undo            |
| `close()`                   | Detaches listeners and stops the timer                                    |
| `getClient()`               | The active `ArgosClient`, or `undefined`                                  |

Every call is a no-op before `init`. Analytics must never break the host app.

`ArgosClient` is exported too, for apps that would rather hold the instance
than use the module-level singleton.

### init options

| Option            | Default      | Notes                                                        |
| ----------------- | ------------ | ------------------------------------------------------------ |
| `dsn`             | —            | Required unless `projectId` + `publicKey` + `host` are given |
| `environment`     | `production` |                                                              |
| `release`         | —            |                                                              |
| `flushIntervalMs` | `5000`       |                                                              |
| `maxBatchSize`    | `50`         | Also the trigger for an immediate flush                      |
| `maxBufferSize`   | `1000`       | Past this the oldest events are dropped and counted          |
| `autoPageviews`   | `false`      | `true` or `{ ignoreParams, hashMode }` — see below           |
| `webVitals`       | `false`      | One `web_vital` event per metric, on page hide               |

### Automatic pageviews

```ts
init({ dsn, autoPageviews: true });
```

Fires on load, on `history.pushState` / `replaceState`, and on `popstate`.
Props: `path`, `title`, `previous_path`, plus the attribution below.

A pageview is emitted only when the **page identity** changes. That identity is
the pathname plus the query parameters that select content, sorted; `utm_*` and
the usual click ids (`gclid`, `fbclid`, …) are dropped, and so is the hash.
A `replaceState` that only rewrites campaign parameters is therefore the same
page, not a second pageview.

| Option         | Default   | Notes                                                              |
| -------------- | --------- | ------------------------------------------------------------------ |
| `ignoreParams` | click ids | Replaces the built-in list; `utm_*` is always ignored on top of it |
| `hashMode`     | `false`   | Make the hash part of the identity, for hash-based routers         |

`close()` restores the original `pushState` and `replaceState`.

### Attribution

Every pageview — automatic or from `pageview()` — carries the campaign
parameters of the **current** URL, when they are there:

| Prop                                                                  | When                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` | Present and non-blank in the URL, trimmed, capped at 200 chars |
| `click_id_source`                                                     | An ad-network click id is present: `gclid`, `fbclid`, …        |

Nothing is remembered between pageviews: a second pageview without a campaign
sends none, and the server keeps the first one of the session. `click_id_source`
is the **parameter name only** — the click id value itself is never sent.

Reporting these is not the same thing as identifying a page. `pageKey()` still
strips `utm_*` and the click ids, so a campaign-tagged landing is the same page
as an untagged one.

And once per visit, on the first pageview, what no request header carries:

| Prop                                | Source                           |
| ----------------------------------- | -------------------------------- |
| `referrer`                          | `document.referrer` at the entry |
| `screen_width`, `screen_height`     | `screen`                         |
| `viewport_width`, `viewport_height` | `innerWidth` / `innerHeight`     |
| `language`                          | `navigator.language`             |

Browser, OS and device type are not sent: ingest reads them from the
User-Agent. Anything the browser does not expose is left out rather than sent
as zero. Details and what was rejected: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

### Web vitals

```ts
init({ dsn, webVitals: true });
```

LCP, CLS, INP, FCP and TTFB, read straight from `PerformanceObserver` — no
`web-vitals` dependency. Each metric is reported **once**, on page hide, as
`track('web_vital', { metric, value, rating, path })`, riding the same unload
batch as everything else. An entry type the browser does not support (INP on
Safari) is skipped silently.

### instrumentFetch options

`origins` is an allowlist of exact origin strings or regexes. The default is
same-origin only: session ids are correlation data and never go to a third
party by accident.

```ts
const undo = instrumentFetch({ origins: ['https://api.example.com', /\.example\.com$/] });
```

## Behaviour worth knowing

- **`anon_id`** — UUIDv4 in `localStorage`, stable across visits.
- **`session_id`** — UUIDv7 in `sessionStorage`, renewed after 30 minutes of
  inactivity. Any tracked event or outbound instrumented request counts as
  activity.
- **Storage blocked** (private mode, blocked cookies) degrades to in-memory
  instead of throwing. Ids then last as long as the page does.
- **Flush triggers** — the timer, a full batch, `visibilitychange → hidden`,
  and `pagehide`. The unload path uses `navigator.sendBeacon`.
- **Retries** — network errors and 5xx back off exponentially; 429 honours
  `Retry-After`. Every other 4xx is a permanent client bug and is never
  retried.

## Development

```bash
make install
make check    # lint, typecheck, test, build
```

`make help` lists every target. Details in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Conventions

Code, comments, file and variable names are in English. Comments explain
**why**, never what; anything longer belongs in `docs/`.
