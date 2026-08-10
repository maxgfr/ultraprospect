# Contributing

```bash
pnpm install
pnpm test              # unit suite — no network; a live call throws with the URL
pnpm run eval          # offline pipeline eval over a recorded sweep
pnpm run check:build   # the committed bundle matches the source, and the skill installs whole
```

Conventional Commits drive the release (`feat:` minor, `fix:` patch, `!` major).

## Two rules that are not style preferences

**No network in the unit suite.** `tests/setup.ts` replaces `global.fetch` with
one that throws and names the URL. Every upstream here is a live public service,
three of them volunteer-run: a unit test that reaches Overpass measures today's
weather, fails on a plane, and adds load to somebody else's server on every CI
run. Use a recorded fixture, mock `./engine.js`, or put the check in
`evals/run.mjs --suite network`, which is opt-in and report-only.

**No re-forking the engine.** Retrieval, caching, politeness, run directories,
artifacts, CLI parsing and MCP all come from the vendored webindex engine via
`src/engine.js`. `pnpm run verify:engine` fails the build if any module under
`src/` *declares* a name the engine already exports — re-exporting is fine,
re-implementing is the regression it exists to catch. If the engine is missing
something, add it there and re-pin.

## When you touch the honesty machinery

Three behaviours are the product, not implementation details. Changing them
needs a test that would fail without the change:

- A sweep that could not cover its territory sets `manifest.truncated`.
- A match the scorer is unsure about goes to `MATCH.todo.json`, unmerged.
- A contact that does not appear verbatim in a fetched page is never written.

## Regenerating the NAF catalogue

`src/naf.ts` is generated from the register's own validation error (it answers a
rejected `activite_principale` with the complete list of valid ones):

```bash
node scripts/refresh-naf.mjs          # rewrite
node scripts/refresh-naf.mjs --check  # CI: fail if stale
```
