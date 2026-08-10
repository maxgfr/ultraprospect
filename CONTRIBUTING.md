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
- A register lane says whether it SWEPT the territory or CONFIRMED it company by
  company. Only France can be swept, and a confirmed run presented as a swept
  one is the most expensive lie this tool could tell.
- A match the scorer is unsure about goes to `MATCH.todo.json`, unmerged.
- A contact that does not appear verbatim in a fetched page is never written.
- A legal identifier that produced an identity must still be readable in the
  page it cites.

## Regenerating the French activity catalogue

`src/classification/naf-codes.ts` is generated from the French register's own
validation error (it answers a rejected `activite_principale` with the complete
list of valid ones). It is FRANCE ONLY and deliberately not replicated per
country: the exhaustive code list exists solely because that API caps a result
set at 10 000 and refuses a prefix filter. The section structure those codes
hang off is NACE rev.2 and lives hand-written in `src/classification/nace.ts`,
shared with the German, Spanish and British connectors.

```bash
node scripts/refresh-naf.mjs          # rewrite
node scripts/refresh-naf.mjs --check  # CI: fail if stale
```

## Adding a country

One file under `src/registry/`, one entry in `CONNECTORS`, and nothing else.
That table is read by the sweep lane, `confirm`, `doctor`,
`manifest.licences` and the weekly canary, so a new connector arrives with its
own drift detection.

Two rules earned by the ones already there:

- **Declare only what the API can do.** If it has no name search, do not write
  a `lookup` that fakes one. If it cannot enumerate a bounded area, do not
  declare `sweep` — a locality string is not a bounding box, and labelling a
  different territory "whole" is the failure this tool exists to refuse.
- **Write the canary from the live response, not from the docs.** Every
  connector here had at least one field that did not mean what its name
  suggested, and each of those is now an assertion.
