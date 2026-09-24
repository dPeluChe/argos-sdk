# Contributing to argos-sdk

Argos is five repositories deployed as one product. **Read the workspace guide
first** — how to bring the whole system up, seed data, and the rules that hold
across all five live in `../CONTRIBUTING.md`.

This file is only what is specific to the SDK.

## Before a commit

```bash
make check    # lint, typecheck, test, build, size budget; CI runs the same
```

The size budget follows imports rather than measuring files, so adding an entry
point cannot make the browser bundle look smaller than it is.

## Three rules that are not obvious

- **Zero runtime dependencies, on purpose.** UUIDv7, W3C Trace Context and W3C
  Baggage are implemented here rather than pulled in. This code runs inside
  somebody else's application; every dependency is one they did not choose.
- **Nothing may break the host application.** `init()` never throws. Every
  entry point is a no-op before `init` and after `close`. Telemetry that can
  take down what it observes is worse than no telemetry.
- **The correlation keys are a wire contract** with
  `argos-workers/internal/envelope/correlate.go`. Renaming one silently stops
  errors correlating and nothing else fails — `test/sentry.test.ts` pins them
  for exactly that reason.

## Where to start reading

`README.md` is the API. `docs/DEVELOPMENT.md` covers the build and what was
rejected along the way.
