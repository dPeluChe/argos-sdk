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
  context.ts     campaign parameters and the browser-only entry context
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

### Attribution is not page identity

Two jobs share the same query string and must not share the same rule.

`pageKey()` answers _"is this the same page"_ and therefore drops `utm_*` and
the click ids: arriving with a campaign tag is not a different page. Attribution
answers _"where did this visit come from"_ and needs exactly those parameters.
The rule that identifies a page stays untouched; the campaign list in
`context.ts` is deliberately a second, separate list — `ignoreParams` may
replace the pageview one, and it must not be able to switch off reporting.

`utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and `utm_term` are
read from the live URL on **every** pageview and never remembered. A value is
sent only when it is there and non-blank, so absence stays absence rather than
becoming an empty string, and a second pageview without a campaign carries
none. Nothing client-side decides which one counts: the SDK reports what the
URL says and the server keeps the first per session. That also handles the case
a client-side memory would get wrong — a user who leaves and re-enters mid-visit
through a different ad genuinely produced a second campaign, and the server
should see it.

Values are trimmed and capped at 200 characters, the same limit event names get.

#### Click ids: the network, not the id

`gclid`, `fbclid`, `msclkid`, `ttclid`, `twclid` and `yclid` are reported as
`click_id_source: 'gclid'` — the parameter name only, never its value.

Reporting nothing was the wrong answer. Google Ads auto-tagging sends `gclid`
with no `utm_*` at all by default, and Meta does the same with `fbclid`; a
platform that ignores them files a large share of paid traffic as direct, which
is the exact question this feature exists to answer. Reporting the value was
also wrong: a click id is an opaque per-click identifier whose only real use is
uploading conversions back to the ad network — a job Argos does not do — and
storing one raises the privacy weight of every session row for a column nobody
queries. The parameter name is one short, low-cardinality string, present only
on paid entries, and it carries the whole analytical signal.

`_ga`, `ref`, `igshid`, `mc_cid` and `mc_eid` stay out even though `pageKey()`
drops them too. `_ga` is a cross-domain session linker, not a click; `ref` is an
unspecified free-for-all any site sets to anything; `igshid` rides every shared
Instagram link, paid or not; and Mailchimp already sends real `utm_*`.

### The entry context

`referrer`, `screen_width`, `screen_height`, `viewport_width`,
`viewport_height` and `language` go out **once per visit**, on the first
pageview. `Identity.claimEntry()` holds the flag in `sessionStorage` keyed by
the session id, so it renews with the session and an MPA does not resend the
same six fields on every page load.

They are here because no request header carries them: ingest parses the
User-Agent for `browser`, `os` and `device_type`, but a UA string has never
contained a screen size or a viewport. `language` duplicates `Accept-Language`
in principle, and is sent anyway — it is five bytes once a visit, it is the
single resolved locale rather than a weighted list, and it survives a CDN or
proxy that normalizes the header away.

Unlike the campaign tags, these are gated: a screen does not change mid-visit,
so a second copy is pure cost.

`referrer` moved to the entry for the same reason plus a correctness one:
`document.referrer` does not change on SPA navigation, so repeating it made
every route change look like it arrived from the external source. Internal
movement is already described by `previous_path`.

Rejected, each of them cheap and none of them worth a field on every visit:
timezone (the IP already places the visitor, and it is a fingerprinting
surface), `devicePixelRatio`, `screen.colorDepth`, `navigator.connection`,
`hardwareConcurrency` and `deviceMemory` (fingerprinting entropy with no
analytics screen behind it), and anything the server already derives from the
User-Agent.

Everything degrades to absence: a missing `screen`, `navigator` or window
dimension drops those keys instead of sending zeros, and no `location` at all
produces a pageview with no attribution rather than an exception.

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
