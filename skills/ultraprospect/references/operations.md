# Operations

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | A gate failed, or nothing was produced. `scan` with zero places; `match` given verdicts for another run. |
| 2 | Usage error, **or a deliberate refusal**. An ambiguous place name exits 2 with the candidate list. |

Anything non-zero means stop and fix. It never means present the result anyway.

## stdout vs stderr

stdout carries the payload — the JSON under `--json`, otherwise the one thing
worth piping (the run directory, for `scan`). stderr carries progress, warnings,
coverage summaries and the next command to run. So this works:

```bash
RUN=$(ultraprospect scan --where "Vincennes" --country fr)
ultraprospect match --run "$RUN" --apply verdicts.json
```

Every stderr hint names the next step with absolute paths, because an installed
skill runs far from the user's project.

## The run directory

```
<out>/runs/<slug>-<id>/
  manifest.json      target, filters, per-lane coverage, counts, notes, licences, timings
  osm.json           raw OSM lane output
  sirene.json        raw register lane output
  places.json        the fused entities — the only input later stages read
  MATCH.todo.json    pairs the matcher would not decide
```

Raw lane output sits beside the fused result deliberately. When a match looks
wrong six weeks later the question is "what did the upstream actually say", and
re-running answers a different question because the upstreams have moved.

`--run` accepts either the run directory or a root, in which case the newest run
under it is taken.

## Reading the manifest

`lanes[]` is the honest part. Each entry has `returned`, `truncated`, a
`reason`, and how many partitions the lane needed:

```json
{ "lane": "sirene", "returned": 672, "truncated": false, "partitions": 1 }
{ "lane": "sirene", "returned": 3000, "truncated": true,
  "reason": "the --max-results budget of 3000 was reached", "partitions": 21 }
{ "lane": "sirene", "returned": 0, "truncated": false,
  "reason": "not applicable outside France (country=de)" }
```

The third is not a failure. "Not applicable" and "failed" are different states
and the manifest keeps them apart; describe them differently.

`manifest.truncated` is the OR of every lane. When it is true, say so first.

## Environment

| Variable | Effect |
|---|---|
| `ULTRAPROSPECT_CACHE_DIR` | Where fetched pages are cached. Default `<tmpdir>/ultraprospect`. |
| `ULTRAPROSPECT_CACHE_TTL_HOURS` | Cache lifetime. Default 24 h. |
| `ULTRAPROSPECT_NO_WRITE=1` | Same as `--stdout`: produce nothing on disk. |
| `ULTRAPROSPECT_POLITE_DELAY_MS` | Per-host delay between requests. Default 400. |
| `ULTRAPROSPECT_MAX_ATTEMPTS` | Retries on a transient HTTP failure, 1–5. |
| `ULTRAPROSPECT_UA` | Override the User-Agent for ordinary web fetches. Does **not** apply to OSM and data.gouv endpoints, which always get the identifying one. |

## Cost and pacing

The register is paced at 5 req/s against an allowed 7. A whole French commune
without filters is roughly 1 500 requests and several minutes, which is why
`--max-results` defaults to 3 000 and why `--min-effectif` / `--section` are the
normal way to run it.

Overpass is the slow half. A single town query is one request that can take two
minutes when the mirrors are queueing, and the engine will not parallelise it —
these are volunteer instances and a burst is how a client gets blocked.

## Offline and deterministic runs

```bash
ultraprospect scan --where "Vincennes" --country fr --record ./fixtures/vincennes
ultraprospect scan --fixture ./fixtures/vincennes
```

`--record` writes the lane output as a replayable sweep; `--fixture` replays it
with no network at all, including the geocode (the fixture carries the target it
was recorded for). Everything downstream of retrieval runs exactly as it does
live, which is what makes the pipeline testable without five live services.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `where` exits 2 with candidates | Working as designed. Pass `--pick <n>` or a more specific query. |
| `0/4 Overpass mirrors answering` | All instances busy. `doctor` again in a few minutes. |
| An Overpass mirror reports "regional extract" | It serves a country subset, not the planet. It is excluded automatically. |
| OSM lane `truncated` | A tile failed after the split budget. Re-run; a different mirror will usually answer. |
| Register lane `truncated` at 10 000 | The territory exceeds the API's ceiling even split by NAF division. Add `--naf` or `--min-effectif`. |
| Register lane returned far more than expected | Ceased companies are excluded by default; check whether `--include-ceased` was passed. |
| A run wrote nothing | `--stdout` or `ULTRAPROSPECT_NO_WRITE=1` is set. |
| `places.json is missing` | The `--run` path points at a directory that is not a run. |
