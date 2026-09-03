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
  registry.json      raw register output, whichever connectors answered
  places.json        the fused entities — the only input later stages read
  MATCH.todo.json    pairs the matcher would not decide
```

Raw lane output sits beside the fused result deliberately. When a match looks
wrong six weeks later the question is "what did the upstream actually say", and
re-running answers a different question because the upstreams have moved.

`--run` accepts either the run directory or a root, in which case the newest run
under it is taken.

## Reading the manifest

`manifest.filters.legalForms` and `manifest.filters.excludeLegalForms` record
the filed legal-form codes passed to `--legal-form` and
`--exclude-legal-form`. `null` means no such filter was requested. Exclusions
are client-side because the French API offers no negation.

When the French register spreads `--max-results` across NACE sections,
`sectionTotals` records the total reported by each section's probe and
`sectionReturned` records how many rows its quota returned. Both maps use NACE
section letters (`A` through `U`) as keys; the example below shortens both maps.
Read them with `reason`: the 21 probes measure how the budget was spread; they
do not make the sampled lane complete. If the budget is smaller than the
number of populated sections, the reason states how many populated sections
necessarily received a zero quota.

`lanes[]` is the honest part. Each entry has `returned`, `truncated`, a
`reason`, and how many partitions the lane needed:

```json
{ "lane": "registry", "mode": "sweep", "connectorId": "fr-sirene",
  "returned": 672, "truncated": false, "partitions": 1 }
{ "lane": "registry", "mode": "sweep", "connectorId": "fr-sirene",
  "returned": 3000, "truncated": true,
  "reason": "the --max-results budget of 3000 was spread across 21 NACE sections after 21 extra probes; the lane is a per-section SAMPLE, not a prefix and not the whole",
  "partitions": 21,
  "sectionTotals": { "A": 42, "B": 18, "C": 6800 },
  "sectionReturned": { "A": 42, "B": 18, "C": 2940 } }
{ "lane": "registry", "connectorId": "eu-vies", "returned": 0, "truncated": false,
  "reason": "no register can be swept for country=de; OSM covered the territory and eu-vies, gleif can confirm each company (run `confirm`)" }
{ "lane": "registry", "mode": "confirm", "connectorId": "eu-vies,gleif",
  "returned": 12, "truncated": false,
  "reason": "confirmed one company at a time: 4 by a published registration number, 8 by a name lookup, 31 not found. This is NOT a sweep — companies absent from OSM are absent from this run." }
{ "lane": "registry", "mode": "sweep", "connectorId": "gb-companies-house",
  "returned": 214, "truncated": false,
  "reason": "enumerated from the Companies House monthly snapshot by POST TOWN \"Hebden Bridge\" — every company the register files there. A post town is not a bounding box, so this lane's shape does not coincide with the OSM lane's, and a company registered at an accountant's address in another town is absent from it." }
```

**`mode` is the field to read first**, and the report prints it as a column.
`"sweep"` means the register was asked for every company in the area and the
answer is a territory; `"confirm"` means OSM covered the ground and each company
was checked afterwards, so a company nobody has mapped is not in the run at all.

Two registers can be swept and **they are not swept by the same shape**, which is
why the `reason` has to be read alongside the mode. France answers a bounding box.
The United Kingdom answers a POST TOWN out of its monthly snapshot — a real
enumeration of what the register files there, and not the area the OSM lane
covered. Repeat that distinction; do not let "sweep" imply it away.

The `confirm` entry above may also mention places **no authority could be asked
about** — a rate limit, an outage, a rejected key. That is counted apart from "not
found" on purpose: one is the register's answer and the other is our own loss of
reach, and reporting the second as the first says a company is unregistered
because we ran out of quota.

The third entry is not a failure either. "No register can be swept here",
"skipped" and "failed" are three different states and the manifest keeps them
apart; describe them differently.

`manifest.truncated` is the OR of every lane. When it is true, say so first.

## Snapshots, and `asOf`

`ingest --country gb|de` fetches a register's bulk export once and indexes it into
the cache; `ingest --list` says what is cached, its vintage and its size on disk.
Until then those connectors report themselves unavailable WITH the command to run,
and the run continues.

Records that came out of a snapshot carry **`asOf`** — the date the record was
true. Absent means the register was asked just now. It matters most in Germany,
whose export stopped in 2019: an identity from there is who filed under that
number THEN. Write it with its date, and expect `check` to object if you do not.

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

The French register is paced at 5 req/s against an allowed 7. A whole commune
without filters is roughly 1 500 requests and several minutes, which is why
`--max-results` defaults to 3 000 and why `--min-employees` / `--section` are the
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
| Register lane `truncated` at 10 000 | The territory exceeds the API's ceiling even split by NACE division. Add `--activity` or `--min-employees`. |
| Register lane returned far more than expected | Ceased companies are excluded by default; check whether `--include-ceased` was passed. |
| A run wrote nothing | `--stdout` or `ULTRAPROSPECT_NO_WRITE=1` is set. |
| `places.json is missing` | The `--run` path points at a directory that is not a run. |
