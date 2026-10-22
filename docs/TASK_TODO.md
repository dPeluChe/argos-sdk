# argos-sdk: Task Backlog

> Open work for this repo. Completed work is archived by month in [TASK_COMPLETED/](./TASK_COMPLETED/).
> The workspace holds no backlog. Open work is split into one slice per repo, each with a Related line naming the other repos involved.

---

## Performance

Audit of 2026-10-22, read from code (no bundle or payload measured). Order is priority.

- [ ] Load optional modules on demand `added: 2026-10-22`
      Outcome: vitals, engagement, clicks and heartbeat behind dynamic `import()` or a `/lite` entry (`src/client.ts:4-15`). Not done in the idle-timers PR: `ClickTracker` and `VitalsCollector` are public exports of `src/index.ts`, so a dynamic import cannot split them without an API change (a `/lite` entry); engagement and heartbeat are on by default, so splitting them saves nothing in the default config; `dist/index.js` is 34.6 KB raw plus a 10.8 KB shared chunk.
- [ ] Fold the startup heartbeat into the first batch `added: 2026-10-22`
      Outcome: one request fewer on first load (`src/heartbeat.ts:100`).

## Open

- [ ] **Feature flags as a first-class event dimension.** The SDK captures the active flags and sends them with every event; nothing exists in code yet. (added: 2026-10-15)
  - Related: argos-workers (storage), argos-backend (filter), argos-frontend (show).
- [ ] **Feedback as its own wire object.** The SDK sends it separately from the event, so a thumbs down can arrive minutes later without rewriting the stored event. Shape like `POST /v1/signals/track` with `event_id` (see `../docs/RESEARCH/RAINDROP.md`). (added: 2026-10-15)
  - Related: argos-workers (owner, ingest), argos-backend (read).
- [ ] **Decision: stable or rotating `anon_id`, and an optional cookieless mode.** The SDK owns it. Today `anon_id` lives in browser storage (`src/session.ts`). Cookieless mode would hash a rotating salt with user agent plus IP, like Plausible and Umami. It has legal consequences in the EU. Decide before the schema hardens. (added: 2026-10-15)
  - Related: argos-workers (sessionizer midnight bridge).
- [ ] **RB-1: point 2 or 3 of the lab's 18 applications at a real instance for 7 days** (not all 18). Human validation of the SDK integration; procedure in `../docs/GUIDES/VALIDATION_RUNBOOKS.md`. (added: 2026-10-15)
  - Related: argos-sdk-demo (reference integration), argos-workers and argos-backend (the instance under test).

## Ideas (not scheduled)

- **Grow `argos-sourcemaps` into a general CLI.** The workspace item "`argos releases files upload`" (so each app's CI need not use `curl`) is mostly covered: `argos-sourcemaps upload` (`src/cli`) walks directories for `*.map`, uploads them to a release with `--release`, `--api`, `--project` or `--dsn`, `--token` (env `ARGOS_UPLOAD_TOKEN`), `--include-sources` and `--dry-run`, and exits 0, 1 or 2. Only a broader `argos releases ...` command surface is left. (added: 2026-10-15)
  - Related: argos-backend (releases files API).
