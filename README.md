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
that; it speaks the same protocol. This package adds what no standard covers —
including the one line that makes those errors land in the same session as the
clicks around them:

```js
import * as Sentry from '@sentry/browser';
import { argosBeforeSend, init } from '@argos/browser';

init({ dsn, autoPageviews: true });
Sentry.init({ dsn, beforeSend: argosBeforeSend });
```

Tested against Sentry **11** (`@sentry/browser` and `@sentry/node`): a type
test in `test/types/` assigns `argosBeforeSend` to `beforeSend` under `strict`
and `exactOptionalPropertyTypes`, and runs in `npm run typecheck`.

Already have a `beforeSend`? Wrap it. `argosBeforeSend` passes a dropped event
(`null`) through as `null`, and awaits a promise before correlating it, so a
sync or async hook composes the same way:

```js
Sentry.init({
  dsn,
  beforeSend: (event, hint) => argosBeforeSend(scrub(event, hint)),
});
```

Without `beforeSend`, both halves still work and both still store — the errors
simply arrive with no session, and no screen can put them next to the visit
that produced them. Correlation is the one thing that cannot be repaired
afterwards, so this is the line to not skip.

Zero runtime dependencies. UUIDv7, W3C Trace Context and W3C Baggage are
implemented here rather than pulled in.

## Install

Not published to a registry yet — `npm install @argos/browser` returns a 404.
Install it from the repository, which builds on install through the `prepare`
script:

```bash
npm install github:dPeluChe/argos-sdk
```

The package name stays `@argos/browser`, so every import below is unchanged.
Verified from a clean directory: npm clones, runs the build and resolves
`dist/`.

## Consent, and what is written before it

`requireConsent` is off by default, so upgrading does not silently stop an
install's data arriving. Turned on, nothing is stored on the device and nothing
is sent until `grantConsent()` — the check sits in front of building an event,
because building one is what creates and persists the anonymous id.

Events from before a yes are **dropped, not buffered**: holding them until
consent arrives is still having collected them before it did.

A refusal is the one sticky direction. After `revokeConsent()`, an install that
does not require consent does not read that silence as a fresh yes.

The startup heartbeat (below) follows the same gate: with `requireConsent` on,
it waits for `grantConsent()`, and after a refusal it is never sent.

## Startup heartbeat

An install that only reports errors cannot prove it is live: no news is not
evidence. So `init` and `initServer` each send one small heartbeat to
`POST /api/{project}/heartbeat/`, and the workspace's `/check` lists what has
checked in under `components`.

```json
{
  "environment": "production",
  "release": "web@1.4.0",
  "runtime": "browser",
  "sdk": { "name": "@argos/browser", "version": "0.8.5" },
  "sentry": { "name": "sentry.javascript.browser", "version": "11.0.0" }
}
```

That is the whole body: no ids, no URL, nothing about the visitor. `environment`
and `release` are the ones events carry. `sentry` is a Sentry SDK found on the
page or process (read off its global, never imported), or `null`.

- **Browser:** at most once per browser per day (the date is kept in
  `localStorage` under `argos.heartbeat`; without storage, once per page load),
  and only once consent allows sending. `runtime` is `browser`.
- **Server:** once per process, right after `initServer`. `runtime` is `node`,
  `sdk.name` is `@argos/browser/server`.

It is fire and forget: a failure never throws, and with `debug: true` it logs
`heartbeat delivered` or `heartbeat failed`. `heartbeat: false` turns it off.

## The tenant an event happened in

`account(id)` marks which workspace, company or team a visit belongs to, and it
sticks like the anonymous id — every later event carries it without being told
again. `signOut()` forgets the person and the tenant and keeps the anonymous id,
which is about the device.

Pass a **stable identifier**: a row id, a UUID. Never a display name. It is
stored exactly as given and never normalised, so `Acme`, `acme` and `acme ` are
three different tenants for the rest of time.

## What survives a closed tab

Whatever could not be delivered is written to `localStorage` and sent by the
next visit: at most 200 events, none older than seven days. That age is not a
round number — it matches `MaxBackdate` in the ingest, which **clamps** an older
timestamp instead of refusing it. Inside the window a resend is a no-op, because
the stored row's key is the event's own id and time. Past it, the same event
would land a second time carrying a moment that never happened.

Nothing waits for the 5 s timer when the page goes. A landing page left for
`/login` by a full navigation one second in still sends its pageview:
`visibilitychange → hidden` or `pagehide` (whichever fires first) hands the
whole buffer to `navigator.sendBeacon`. The beacon body is `text/plain` on
purpose, so a cross-origin ingest needs no preflight. It can still be lost if
the pageview was never recorded (consent pending, `autoPageviews` off and no
`pageview()` call, `init` running after the click), or if the browser accepts
the beacon and the network then drops it. When `sendBeacon` refuses or throws,
the batch goes to the outbox and a keepalive `fetch`.

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

| Function                             | What it does                                                              |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `init(options)`                      | Creates the client, starts the flush timer, returns it                    |
| `track(name, props?)`                | Queues a product event                                                    |
| `pageview(path?)`                    | `track('pageview', …)` with attribution; defaults to `location.pathname`  |
| `identify(userId)`                   | Writes the `anon_id → user_id` alias and stamps `user_id` on later events |
| `account(accountId)`                 | Sets the tenant; sticky, stamped on every later event                     |
| `signOut()`                          | Clears the user and the tenant                                            |
| `grantConsent()` / `revokeConsent()` | See "Consent" above                                                       |
| `argosBeforeSend`                    | Sentry `beforeSend` hook: stamps the visit onto an error                  |
| `correlation()`                      | The current session, anon, user and account ids                           |
| `flush()`                            | Sends everything buffered; resolves when the queue drains                 |
| `traceHeaders()`                     | `{ traceparent, baggage }` for one outbound request                       |
| `instrumentFetch(options?)`          | Wraps `window.fetch` to attach those headers; returns the undo            |
| `close()`                            | Detaches listeners and stops the timer                                    |
| `getClient()`                        | The active `ArgosClient`, or `undefined`                                  |

Every call is a no-op before `init`. Analytics must never break the host app.

`ArgosClient` is exported too, for apps that would rather hold the instance
than use the module-level singleton.

### Server half: `@argos/browser/server`

For Node. It has no session of its own: it continues the visit the browser
started, read off the `traceparent` and `baggage` that `instrumentFetch`
attached.

```ts
import { initServer } from '@argos/browser/server';

const argos = initServer({ dsn: process.env.ARGOS_DSN });

app.post('/checkout', async (req, res) => {
  argos.visit(req.headers)?.track('order_placed', { total: 42 });
  await argos.flush(); // explicit: a server has no page-hide to flush on
  res.end();
});
```

`visit()` returns `undefined` for a request that did not come from an
instrumented page (a cron, a webhook), so those never count as visits.

`visit()` also takes a web `Headers`, so fetch-style runtimes (Hono, Next.js
route handlers, Cloudflare Workers) pass the request's headers as they are:

```ts
// Hono
app.post('/checkout', async (c) => {
  argos.visit(c.req.raw.headers)?.track('order_placed', { total: 42 });
  await argos.flush();
  return c.json({ ok: true });
});

// Next.js route handler, Workers: same thing with `request.headers`
export async function POST(request: Request) {
  argos.visit(request.headers)?.track('order_placed');
  await argos.flush();
  return Response.json({ ok: true });
}
```

`initServer` takes `debug: true` too, and then logs each request's visit (or
why there was none), each flush's result and the startup heartbeat's.

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
| `autoClicks`      | `false`      | Track elements marked `data-argos-event` — see below         |
| `requireConsent`  | `false`      | See "Consent" above                                          |
| `debug`           | `false`      | Log what the SDK does to the console — see below             |
| `heartbeat`       | `true`       | One startup heartbeat — see "Startup heartbeat"              |

### Debug mode

`init({ debug: true })` logs to `console.info`, every line prefixed `[argos]`,
enough to check an integration without opening the dashboard:

```
[argos] init https://ingest.argos.dev project 42, consent unknown, session 0192f3a7-…
[argos] queue product checkout_started
[argos] drop signup_clicked: consent pending
[argos] flush 2 via fetch
[argos] ingest 401 {"error":"unknown public key"}
[argos] retry 1 in 412ms
[argos] flush 1 via beacon
[argos] outbox kept 3
```

It covers init, every event queued or dropped (and why), every flush and the
transport it used, the ingest status (with the error body on a 4xx), retries,
and the outbox. Calls made before `init` cannot be logged: there is no client
yet to know `debug` was asked for. With `debug` off, nothing is written.

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
| `timezone`                          | `Intl` resolved time zone (IANA) |

Browser, OS and device type are not sent: ingest reads them from the
User-Agent. Country, region and city are not sent either: ingest looks them up
from the request IP and stores them on the visit, never the IP itself.
`timezone` is the fallback when that lookup is off or finds nothing. Anything
the browser does not expose is left out rather than sent
as zero. Details and what was rejected: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

### Click tracking without writing JavaScript

```ts
init({ dsn, autoClicks: true });
```

```html
<button data-argos-event="signup_clicked" data-argos-event-plan="pro">Sign up</button>
```

The name comes from `data-argos-event`, and every `data-argos-event-*`
attribute becomes a prop. The nearest marked ancestor wins, so marking a button
still reports when the click lands on an icon inside it.

**Marked elements only** — never every click. A tracker that reports all of
them collects the text of whatever a person clicked, which is a privacy problem
the install did not ask for.

One delegated listener, registered on the capture phase so a menu or modal that
calls `stopPropagation` cannot silently delete the event. It is passive and
never calls `preventDefault`: an analytics listener that can cancel a click can
break a checkout button.

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

Init order does not matter. When Sentry tracing or OpenTelemetry already
wrote a `baggage` header, the `argos.*` entries are merged into it: foreign
entries are kept, ours replaced, and no key appears twice. An existing
`traceparent` is never overwritten.

## Source maps

A stack trace from minified code points at `main.a1b2.js:1:48213`. Upload the
build's source maps and Argos resolves those frames back to your files, lines
and function names.

**When it applies:** JavaScript or TypeScript that is bundled or minified
before it runs: React, Vite, Next.js, webpack builds in the browser, and Node
services compiled from TypeScript or bundled. It does not apply to Python, Go
or Rust: their stack traces already carry real file names and lines.

**1. Emit maps in the build.** Use _hidden_ maps: the `.map` files are written,
but the bundle carries no `sourceMappingURL` comment, so browsers never fetch
them and your original source is not advertised to visitors.

| Bundler | Setting                                                 |
| ------- | ------------------------------------------------------- |
| Vite    | `build: { sourcemap: 'hidden' }` in `vite.config.ts`    |
| Next.js | `productionBrowserSourceMaps: true` in `next.config.js` |
| webpack | `devtool: 'hidden-source-map'`                          |
| tsc     | `"sourceMap": true` in `tsconfig.json` (Node services)  |

The `.map` files still sit in the output directory. If you do not want them
public, upload them and then delete them before the deploy step copies the
directory to a CDN or static host (Next.js serves them when the flag is on).

**2. Get an upload token** from the application's page in Argos, and keep it
in CI as the secret `ARGOS_UPLOAD_TOKEN`.

**3. Upload in CI, after the build and before the deploy:**

```bash
ARGOS_API_URL=https://argos.example.com \
ARGOS_UPLOAD_TOKEN=${{ secrets.ARGOS_UPLOAD_TOKEN }} \
npx argos-sourcemaps upload --release "web@$GIT_SHA" --dsn "$ARGOS_DSN" dist
```

```
argos-sourcemaps upload --release <release> [--api <url>] [--project <id> | --dsn <dsn>]
                        [--token <t>] [--include-sources] [--dry-run] <dir> [<dir>...]
```

- **`--release` must equal the `release` passed to `Sentry.init` / the Argos
  SDK init**, character for character. Maps are stored per release; a
  mismatch means frames stay minified. Build both from the same variable.
- `--api` (or `ARGOS_API_URL`) is required; there is no default host.
- The project comes from `--project`, or from `--dsn` / `ARGOS_DSN`.
- Files are named by their path relative to each directory given, with
  forward slashes: `dist/assets/app.js.map` passed as `dist` becomes
  `assets/app.js.map`. `node_modules` is skipped.
- `--include-sources` also uploads the `.js`/`.mjs`/`.cjs` file next to each
  map, for maps built without `sourcesContent`.
- `--dry-run` lists what would be sent and needs no token.
- Uploads run four at a time, with one retry on a network error or 5xx.
  A 401 (bad or revoked token) or 404 (wrong project) stops the run; files
  over 20 MiB are skipped with a warning. The exit code is non-zero when any
  upload failed, so the CI step fails. The token is never printed.
- Needs Node 20 or newer, and has no dependencies. It ships in this package
  but is a separate build: it adds nothing to the browser bundle.

## Behaviour worth knowing

- **`anon_id`** — UUIDv4 in `localStorage`, stable across visits.
- **`session_id`** — UUIDv7 in `sessionStorage`, renewed after 30 minutes of
  inactivity. Any tracked event or outbound instrumented request counts as
  activity.
- **`argos.entry_sent`** — internal `sessionStorage` key holding the session id
  whose first pageview has been sent, so screen, viewport, language and time zone ride on
  one pageview per session only. Not an API; do not read or write it.
- **Storage blocked** (private mode, blocked cookies) degrades to in-memory
  instead of throwing. Ids then last as long as the page does.
- **Flush triggers** — the timer, a full batch, `visibilitychange → hidden`,
  and `pagehide`. The unload path uses `navigator.sendBeacon`.
- **`identify` is idempotent** — calling it again with the id already set
  sends nothing, so it is safe to call on every page load.
- **Retries** — network errors and 5xx back off exponentially; 429 honours
  `Retry-After`. Every other 4xx is a permanent client bug and is never
  retried.

## Development

```bash
make install
make check    # lint, typecheck, test, build, size budget
```

`make help` lists every target. Details in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Conventions

Code, comments, file and variable names are in English. Comments explain
**why**, never what; anything longer belongs in `docs/`.
