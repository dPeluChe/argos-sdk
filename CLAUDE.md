# CLAUDE.md: argos-sdk

Part of the Argos workspace. Cross-repo rules, the workspace map and the
contracts between repos live in `../CLAUDE.md` and `../CONTRIBUTING.md`; this
file covers only this repo.

## What it is

`@argos/browser`: product events and session correlation for Argos, in the
browser and in Node, plus the Sentry wiring (`argosBeforeSend`) and the
`argos-sourcemaps` CLI. Errors are not captured here: a Sentry SDK pointed at
Argos does that. There is no Python SDK.

## Stack

TypeScript (strict), tsup (ESM + CJS), Vitest with happy-dom, ESLint and
Prettier. Node >= 20. Zero runtime dependencies. Sentry 11 is a dev dependency,
used only by the type test.

## The check that gates a PR

`make check` (lint, typecheck, test, build, size budget). CI runs the same
steps on Node 20, 22 and 24, plus a check that `init()` lets a Node process
exit. `make help` lists every target.

## Map

- `src/`: the SDK. `index.ts` is the browser surface, `server/` the Node half,
  `cli/` the source map uploader. File by file: `docs/DEVELOPMENT.md`.
- `test/`: Vitest suites, one per module; `test/types/` is the compile-only
  Sentry type test.
- `scripts/size-budget.mjs`: the bundle budget.
- `.github/workflows/`: `ci.yml` and `release-tarball.yml`.

## Docs

- `README.md`: the public API, options, recipes per stack, source maps. Owner
  of the `argosBeforeSend` and source map instructions; the workspace guides
  link here.
- `docs/DEVELOPMENT.md`: layout, gates, design decisions.
- `CONTRIBUTING.md`: the rules that are not obvious.
- Wire contract: `../docs/INGEST_API.md`. Release flow: `../docs/GUIDES/RELEASES.md`.

## Rules for this repo

- `init()` never throws; every entry point is a no-op before `init` and after
  `close`. Nothing here may break the host app.
- No runtime dependencies. UUIDv7, Trace Context and Baggage are in-house.
- The correlation keys are a wire contract with
  `argos-workers/internal/envelope/correlate.go`; `test/sentry.test.ts` pins
  them. Do not rename them.
- `test/readme.test.ts` pins the `### Recipe: <stack>` headings; the frontend
  links to those anchors. Rename one and the links break silently.
- Raising a size budget is deliberate, in the commit that needs it, with the
  reason in the message.
- Change through a branch and a PR. Never push to main. Version bumps and tags
  are a separate release step.
- Code, comments, docs and commits in English; comments say why, not what.
