# Contributing

Thanks for considering a contribution. This is a portfolio project built solo and
day-by-day, but it's structured and tested like a real one, and outside contributions
(bug reports, fixes, questions, ideas) are genuinely welcome.

By participating, you're expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

For anything beyond a small, obvious fix (a typo, an off-by-one, a missing test case),
**open an issue first** to discuss the change before writing code. This project makes
a lot of deliberate, documented tradeoffs (see [`docs/DECISIONS.md`](docs/DECISIONS.md))
— what looks like a gap or a bug might be an intentional, tested boundary. Opening an
issue first avoids spending effort on a PR that turns out to conflict with one of
those decisions.

## Development setup

**Requirements:** Node.js ≥ 20, npm ≥ 10.

```bash
git clone https://github.com/jamnxdev/-billing-ingestion-engine.git
cd billing-ingestion-engine
npm install
npm run build --workspaces
npm run test --workspaces
```

If you only want to work on one package:

```bash
npm run test --workspace=packages/<name>       # e.g. packages/ingest
npm run build --workspace=packages/<name>
```

Tests import other workspace packages by **source**, not built output (via each
package's `vitest.config.ts` `resolve.alias`), so `npm test` never implicitly requires
a prior build. `npm run build` is what proves the *published artifact* (what `dist/`
actually contains) works, not just the source — run it before you consider a change
finished, and ideally do a manual smoke test against the built server
(`node dist/start.js` in `packages/ingest`, per the [Quickstart](README.md#quickstart))
for anything touching the HTTP layer.

## Project structure

See [`README.md`'s Project layout](README.md#project-layout) for the package map and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how they fit together. In short:
`aggregator` is the dependency-free domain core; `ingest` is the HTTP layer built on
it; `testclient` generates deterministic adversarial load; `bench` measures
correctness/throughput/latency using the other three.

## Coding conventions

- **TypeScript, strict mode.** `tsconfig.base.json` sets `strict: true` and
  `noUncheckedIndexedAccess: true` for every package — don't add `any`, non-null
  assertions (`!`), or `@ts-ignore` to work around a type error; fix the underlying
  type instead. (Existing `!` uses in the codebase are each accompanied by a comment
  explaining the invariant that makes them safe — match that standard if you add one.)
- **No background timers for time-based logic.** `DedupStore` and `TokenBucket` both
  compute state lazily from elapsed time against an **injectable clock**
  (`clock: () => number = Date.now`), not a `setInterval`/`setTimeout`. This is what
  keeps their tests deterministic — follow the same pattern for any new time-based
  component, and write tests that advance a fake clock rather than using real
  `sleep()`/timeouts.
- **Domain logic stays decoupled from HTTP.** `packages/aggregator` has zero Fastify
  (or any HTTP) dependency, and should stay that way — HTTP-specific concerns belong
  in `packages/ingest`.
- **Comments explain *why*, not *what*.** Only add a comment for a non-obvious
  constraint, invariant, or rejected alternative — not to restate what well-named code
  already says. See existing files (`DedupStore.ts`, `SlidingWindowAggregator.ts`) for
  the standard.
- **Flag deliberate gaps explicitly, in both code and docs.** If you knowingly leave
  something unhandled (an edge case, a scaling limit), say so directly — in a doc
  comment and in [`docs/DECISIONS.md`](docs/DECISIONS.md) or the README's
  [Known Limitations](README.md#known-limitations) if it's user-visible — rather than
  leaving it silent. This project's whole documentation structure depends on that
  discipline.

## Tests

- Every new behavior needs a test. Every bug fix needs a regression test that fails
  before the fix and passes after.
- Prefer the existing test style per layer: unit tests for pure logic
  (`DedupStore.test.ts`), HTTP tests via `app.inject()` for API behavior
  (`server.test.ts`) — never a real listening socket for correctness tests (reserve
  real sockets for the throughput benchmark, where I/O behavior is exactly what's
  being measured).
- If your change affects order-sensitivity or correctness under randomized input,
  consider a property-based test (`fast-check`) alongside hand-picked examples — see
  `orderIndependence.test.ts` for the pattern, including the async-vs-sync
  `fc.asyncProperty`/`fc.property` distinction called out there.
- A benchmark harness whose **output is a correctness claim** (like
  `CorrectnessBenchmark`) should be unit-tested. A pure timing harness (like
  `ThroughputBenchmark`) doesn't need to be — proving it correct by inspection plus a
  real run is the established convention here; use judgment and say which category
  your change falls into if it's not obvious.

Run the full suite before opening a PR:

```bash
npm run build --workspaces
npm run test --workspaces
```

## Commit messages

Write commit messages that explain **why**, not just what changed — the codebase's own
doc comments and [`docs/DECISIONS.md`](docs/DECISIONS.md) follow the same discipline;
commit history should too.

## Submitting a change

1. Fork the repo and create a branch from `main`.
2. Make your change, with tests, following the conventions above.
3. Run `npm run build --workspaces` and `npm run test --workspaces` — both must pass.
4. Open a pull request describing **what** changed and **why**. If it touches a
   documented design decision, update [`docs/DECISIONS.md`](docs/DECISIONS.md) (or the
   relevant doc) in the same PR — code and docs should never drift apart here.
5. CI (`.github/workflows/ci.yml`) runs build + test on every PR; it must be green
   before merge.

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For a security
vulnerability, do **not** open a public issue — see [`SECURITY.md`](SECURITY.md).

## Questions

Open a [GitHub Discussion](https://github.com/jamnxdev/-billing-ingestion-engine/discussions)
or an issue tagged `question` if discussions aren't enabled on the repo yet.
