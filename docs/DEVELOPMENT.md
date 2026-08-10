# Development

## Layout

```
src/
  index.ts       public surface — module-level singleton over ArgosClient
  client.ts      assembles identity + transport, builds contract-shaped events
  types.ts       the wire types from ../../docs/INGEST_API.md
  dsn.ts         Sentry-shaped DSN parsing, endpoint URLs
  ids.ts         UUIDv4, UUIDv7, trace-id, span-id
  session.ts     anon_id / session_id / user_id and the idle window
  storage.ts     localStorage / sessionStorage with an in-memory fallback
  trace.ts       traceparent and baggage encoding
  transport.ts   buffer, flush triggers, retry policy, sendBeacon
  instrument.ts  the opt-in fetch wrapper and its origin allowlist
  pageviews.ts   history patching, page identity, SPA pageviews
  vitals.ts      LCP, CLS, INP, FCP, TTFB on PerformanceObserver
test/
  setup.ts       storage polyfill, see "Test environment"
```

One package for now. When the Node and Python SDKs arrive, this becomes
`packages/browser` under an npm workspace; nothing in `src/` has to move.

## Gates

`make check` runs all of them, and so does CI on push and PR:

| Gate  | Command                                                                             |
| ----- | ----------------------------------------------------------------------------------- |
| Lint  | `npm run lint` — ESLint `strictTypeChecked`, zero warnings, plus `prettier --check` |
| Types | `npm run typecheck` — `tsc --noEmit`, strict                                        |
| Tests | `npm test` — Vitest                                                                 |
| Build | `npm run build` — tsup, ESM + CJS + `.d.ts`                                         |

## Configuration

There is none at build time. Everything the SDK needs arrives through
`init()`. The DSN is public by design — it ships inside browser bundles and
grants write-only access to one project.

`noUncheckedIndexedAccess` is deliberately off. The byte-array arithmetic in
`ids.ts` would be nothing but non-null assertions with it on, which buys no
safety and costs readability.

## Design notes

### UUIDv7 monotonicity

RFC 9562 offers several ways to keep v7 ids ordered inside one millisecond.
This uses the monotonic counter in `rand_a`: a 12-bit sequence seeded from
randomness at the start of each millisecond and incremented for every id after
it. The seed is masked to 6 bits, so a burst has more than 4000 increments of
headroom before the counter can overflow; if it ever does, the timestamp
borrows a millisecond from the future rather than repeating a value.

The generator also refuses to move backwards. A clock that jumps back — NTP
correction, a user changing the system time — keeps minting ids at the last
observed millisecond instead of producing ids that sort before existing ones.

This matters because `session_id` is a UUIDv7 and the unified session timeline
sorts by it.

### The 30-minute idle window

`sessionId()` renews when `now - seen_at >= 30 min`, and rewrites `seen_at` on
every call. Reading the session id _is_ the activity signal, so a `track()` or
an instrumented outbound request both keep the session alive. A corrupted or
missing `seen_at` starts a fresh session — a session of unknown age is worse
than a new one.

The threshold is `>=`, not `>`: at exactly 30 minutes the session is over.

### Storage fallback

Both stores are probed at construction with a write-and-remove, because Safari
in private mode throws on `setItem` rather than on access, and a blocked-cookie
policy throws on access itself. Writes go to memory first and then to the
backing store inside a `try`, so a quota error mid-session downgrades quietly
instead of losing the id.

The consequence when storage is unavailable: `anon_id` stops being stable
across visits and `session_id` stops surviving navigation. That is the correct
degradation — the alternative is throwing inside someone's app.

### Retry policy

Retryable: a rejected `fetch` (offline, DNS, CORS, abort — the browser gives no
status), 429, and 5xx. Everything else, including 400/403/413, is permanent:
the key is wrong or the body is malformed, and retrying is an infinite loop
against an endpoint that will never accept it.

Delay is `min(500ms · 2^attempt, 30s)` with jitter over the lower half of the
window, capped at 5 sends. A 429 uses `Retry-After` instead — seconds or
HTTP-date — because the server knows better than the backoff does.

Partial success is normal per the wire contract: ingest answers `202` with
accepted/rejected counts and the SDK treats any 2xx/3xx as done. It never
inspects the counts, because a batch is retried whole or not at all.

### Why the buffer is capped

A broken endpoint with an unbounded buffer is a memory leak in someone else's
product. Past `maxBufferSize` the oldest events go — the newest describe what
the user is doing right now — and the running drop count rides on the next
event as `props['argos.dropped_events']`, so the loss shows up in the data
rather than only in a local counter.

### Fetch instrumentation

Opt-in, never automatic. Wrapping `fetch` is the kind of thing that surprises
people, and the headers carry session ids: attaching them to a third-party
request would leak correlation data. The default allowlist is same-origin.

The wrapper builds a `Request` so string, `URL` and `Request` inputs all take
one code path, and it never overwrites a `traceparent` the caller already set —
an app doing its own tracing owns that header.

Baggage carries `argos.session_id` and `argos.anon_id` only, matching the
example in `../../docs/INGEST_API.md` exactly. `user_id` is deliberately left
out: the alias is resolved at query time through `identity_map`, so sending it
on the wire would add a field the backend does not need.

### The page identity rule

`pageKey()` reduces a URL to what a funnel should treat as one page:
`pathname` plus the query parameters that select content, sorted by name and
value. Dropped: anything starting with `utm_`, plus the click ids `gclid`,
`fbclid`, `msclkid`, `ttclid`, `twclid`, `yclid`, `igshid`, `mc_cid`, `mc_eid`,
`ref` and `_ga`. `ignoreParams` replaces that list; the `utm_` prefix is
unconditional.

Sorting matters as much as the deny-list: `?a=1&b=2` and `?b=2&a=1` are the
same page, and a router that rewrites the query in a different order must not
look like a navigation.

The hash is out by default — `#section` is an anchor, not a page — and
`hashMode: true` puts it back for hash-based routers.

A capture whose key equals the previous one emits nothing. That is what makes a
`replaceState` adding `?utm_source=…` after landing free, and it also absorbs
the double `replaceState` several routers do on mount.

`title` is read synchronously at navigation time. A router that sets the title
in an effect after render will have the previous title on that event; deferring
the capture to fix it would break the "exactly one pageview per navigation"
guarantee in a worse way, so the trade is made in favour of the count.

The originals are restored on `close()`. A patched `history` surviving a hot
reload double-counts every navigation, and there is no way to detect it from
inside.

### Web vitals semantics

Each metric has a termination rule, and getting it wrong yields plausible wrong
numbers:

- **LCP** — last `largest-contentful-paint` entry, frozen at the first
  `keydown` / `click` / `pointerdown`, or at page hide if none came. Freezing
  on load instead would report an element the user never waited for.
- **CLS** — the worst _session window_, not the page total. A shift joins the
  current window while it is within 1s of the previous shift and 5s of the
  window start; otherwise it opens a new one. Entries with `hadRecentInput` are
  the user's own doing and are skipped.
- **INP** — the ten longest interactions are kept, keyed by `interactionId`
  (the largest duration per id), and the reported value steps one rank down per
  50 interactions: the worst interaction on a quiet page, roughly the 98th
  percentile on a busy one. `event` entries are observed with
  `durationThreshold: 40`.
- **FCP** — the `first-contentful-paint` paint entry, first one wins.
- **TTFB** — `responseStart` of the navigation entry.

Everything is reported once, on page hide, through the normal `track()` path,
so the vitals ride the same `sendBeacon` batch as the buffered events. The
hidden handler finalizes before it flushes; that ordering is the whole point.

Every `observe()` sits in its own `try`, so an unsupported entry type — `event`
on Safari — costs that one metric and nothing else. CLS is reported even at
zero, because a stable page is a real measurement; INP is not, because "no
interaction" is not an interaction of 0 ms.

### Why the flush timer is unref'd

`setInterval` keeps the Node event loop alive: a script that calls `init()` and
never calls `close()` would hang forever. Browsers return a number from
`setInterval` and have no `unref`, so the call is optional-chained.

### Test environment

Node 26 defines a `localStorage` global that stays `undefined` unless the
process is started with `--localstorage-file`, and it shadows the one happy-dom
installs. `test/setup.ts` puts a real `Storage` implementation back so the
storage tests exercise the browser path instead of the fallback.

`ids.test.ts` re-imports `src/ids.ts` through `vi.resetModules()` for each
case, because the UUIDv7 counter is module state and would otherwise leak
between tests.
