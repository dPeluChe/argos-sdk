# CLAUDE.md: argos-sdk

This repo is the Argos client library for browsers and Node. It records product
events and ties them to a session, and it wires Sentry errors to the same
session. It also ships a small tool that uploads source maps. It does not
capture errors itself, and there is no Python version.

## Read first

- `../CLAUDE.md` and `../CONTRIBUTING.md`: workspace map, rules shared by all
  five repos, and how to bring the system up.
- `docs/DEVELOPMENT.md`: the stack, the file layout, the gate to run before a
  commit and the CI matrix, the section "Rules for this repo", and the design
  decisions.
- `CONTRIBUTING.md`: what is specific to this repo and the three rules that are
  not obvious.
- `README.md`: the public API, options, recipes per stack and source maps. It
  owns the Sentry hook and source map instructions that the workspace guides
  link to.
- `../docs/INGEST_API.md`: the wire contract with ingest.
- `../docs/GUIDES/RELEASES.md`: version bumps, tags and the release flow.
