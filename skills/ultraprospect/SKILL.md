---
name: ultraprospect
description: "Use when the user wants every company in a PLACE — a town, a street, a radius — turned into a qualified, sourced prospect list rather than a page of search results. A deterministic zero-dep engine (node scripts/ultraprospect.mjs, no keys, no install) sweeps OpenStreetMap worldwide and the French register (SIRENE/RNE) for the same territory, fuses the two into one entity per company, and hands YOU the judgment it refuses to make: which near-miss pairs are the same business, what a company does, whether it fits the brief. It REFUSES an ambiguous place name, REFUSES to merge an uncertain pair, and DECLARES a partial sweep truncated rather than passing it off as a whole territory. Triggers: 'find every company in X', 'list the businesses on this street', 'who is based in <town>', 'build a prospect list for <area>', 'quelles entreprises à <ville>', 'prospection sur <zone>'. Not for researching one named company, and not for a codebase."
license: MIT
metadata:
  version: 1.4.4
---

# ultraprospect — a territory, turned into prospects you can cite

Like its `ultra*` siblings this is a **division of labour**. The engine decides
the mechanics: geocode the place, sweep both lanes, tile around the upstream
caps, fuse what is certainly the same company, account for what it could not
reach. You decide the judgment: whether a near-miss pair is one business, what a
company actually does, which of them is worth a call.

The engine is built to be boring and honest about its edges. Nothing it produces
is a guess dressed as a fact, and every count it reports is one it measured.

> **The core rules:**
>
> 1. **Reason from the run, not from memory.** You know nothing about a town's
>    economy that is not in `places.json`. If it is not in the run, fetch it or
>    say you did not.
> 2. **A truncated run is a truncated run.** When `manifest.truncated` is true,
>    say so in the first sentence of whatever you write, and name the lane. A
>    partial sweep presented as a whole territory is the one failure nobody
>    downstream can detect.
> 3. **Absence is a finding.** `isHiring: false` means we looked where hiring
>    would be and found none; `isHiring` absent means a board exists that we
>    could not read. Report the second as unknown, never as "not hiring".
> 4. **Never invent a contact.** Every email, phone number and person must
>    appear verbatim in a fetched page or an open-data record. Do not
>    reconstruct `prenom.nom@domaine` from a pattern — a plausible address is
>    worse than none.
> 5. **Adjudicate, don't rubber-stamp.** `MATCH.todo.json` exists because the
>    matcher refused to decide. Read the evidence in each pair and answer it;
>    approving the file wholesale throws away the reason it was written.
> 6. **The attribution travels with the data.** OSM is ODbL: any list you hand
>    over carries the notice the manifest gives you.

## Running the engine

An installed skill lives away from the user's project, so a cwd-relative path
will NOT resolve. Use the absolute path to this skill's directory:

```bash
node <skill-dir>/scripts/ultraprospect.mjs <command> [options]
```

`--help` is the full flag surface and is kept in sync with the code by a build
gate. Read it rather than guessing a flag.

## Route the ask

| You want to… | Run |
|---|---|
| Check a place name resolves, before spending a sweep | `where "<place>"` |
| List every company in a town, street or radius | `scan --where "<place>"` |
| Same, narrowed to an industry or a company size | `scan --where "<place>" --section J,M --min-employees 10` |
| Answer the pairs the matcher would not decide | `match --run <dir> --apply verdicts.json` |
| Find each company's website (your WebSearch) | `resolve --run <dir> --queries`, then `--web-results` |
| Read those websites — what they do, who they hire | `enrich --run <dir> --tier 1`, then `--tier 2 --limit 20` |
| Attach a register identity outside France's sweep | `confirm --run <dir>` |
| Rank what you found | `score --run <dir>` |
| Write up one company from its evidence | `dossier --run <dir> --id <id>` |
| Prove the write-up is grounded before anyone reads it | `check --run <dir>` |
| Hand it over: CSV, report, one self-contained page | `render --run <dir>` |
| See what moved since last month's sweep | `watch --run <new> --since <old>` |
| Spread the judgement across subagents | `orchestrate --run <dir>` |
| Drive it all from another harness | `mcp` |
| Find out why a run came back thin | `doctor` |

## Cheat sheet

```bash
ultraprospect doctor                                          # are the five upstreams up?
ultraprospect where "Vincennes" --country fr                  # resolve, or list the candidates and exit 2
ultraprospect scan --where "Vincennes" --country fr           # both lanes, fused
ultraprospect scan --lat 48.8566 --long 2.3522 --radius 500m  # a point and a radius
ultraprospect scan --where "Lyon" --section M --min-employees 20 --out ./runs
ultraprospect scan --where "Berlin" --country de              # OSM sweeps the ground; the register comes later
ultraprospect confirm --run <dir>                             # Impressum -> HRB/USt-IdNr -> the authority confirms
ultraprospect scan --where "Berlin" --no-registry             # skip the register lane entirely
ultraprospect match --run <dir> --apply verdicts.json         # fold your adjudication back in
ultraprospect resolve --run <dir> --queries                   # the queries for YOU to search
ultraprospect resolve --run <dir> --web-results hits.json     # ingest your hits, fetch, corroborate
ultraprospect enrich --run <dir> --tier 1                     # home + legal notice on every site
ultraprospect enrich --run <dir> --tier 2 --limit 20          # a page per role + the ATS APIs
ultraprospect score --run <dir>                               # rank by measured signals
ultraprospect dossier --run <dir> --id <id>                   # the grounding packet, pages and all
ultraprospect check --run <dir>                               # the gate. Exit 1 means do not present.
ultraprospect render --run <dir>                              # CSV + JSON + REPORT.md + index.html
ultraprospect render --run <dir> --min-fit possible           # only the ones you judged worth it
ultraprospect watch --run <new> --since <old>                 # who opened, closed, started hiring
ultraprospect orchestrate --run <dir>                         # fan the two judgement phases out
ultraprospect mcp                                             # serve it over MCP, stdio
ultraprospect scan --fixture <dir>                            # replay a recorded sweep, offline
```

## Workflow

1. **Resolve the place first.** `where` costs one request and tells you what the
   geocoder thinks you meant. If it exits 2 it has found several distinct places
   with comparable confidence — show the user the list and ask, or pass
   `--pick <n>`. Do not paper over it: "Vincennes" is a Paris suburb *and* a
   town in Indiana, and picking silently produces a complete, plausible,
   entirely wrong prospect file.

2. **Scan, with filters if the territory is dense.** A French commune holds tens
   of thousands of registered units, most of them dormant micro-entrepreneurs.
   `--min-employees`, `--section` and `--activity` are how a run stays useful; the
   register lane stops at `--max-results` and declares itself partial rather
   than spending twenty minutes.

3. **Read the coverage before reading the data.** `manifest.lanes` says what
   each lane returned and whether it was capped. `manifest.truncated` is the
   headline. Outside France the register lane reports "not applicable" — that is
   a property of the territory, not a failure, and should be described as such.

4. **Adjudicate `MATCH.todo.json`.** Each pair carries the OSM name, the register
   name that *actually scored* (`matchedName` — often an enseigne, not the legal
   name), the distance in metres and the component scores. Answer with a JSON
   array of `{osmId, siret, merge, why}` and fold it back with `match --apply`.
   Judge on evidence: same trade name, same street number, a brand the register
   files under an enseigne. When you cannot tell, say `merge: false` — two rows
   are recoverable, one wrong merge is not.

5. **Find the websites — this is your job, and the run rests on it.** Four in
   five places arrive without one, and everything downstream grows from that
   URL. `resolve` will **refuse to run** without search results rather than
   quietly check the handful OSM already tagged: on a real Vincennes sweep that
   silence produced 11 corroborated sites out of 1164, which reads as a town
   with no web presence instead of as a search nobody ran.

   So: `resolve --queries` writes `RESOLVE.todo.json` and prints the queries.
   **Run your own WebSearch once per query.** Pool EVERY hit into one JSON array
   — duplicates, directories, noise and all, `[{"placeId","url","title",
   "snippet"}]` — and pass it back with `--web-results`. Do not filter: you are
   finding candidates, not choosing. The engine fetches each one and keeps it
   only if the page carries the company's SIREN, its street address or the
   distinctive part of its name; a domain that ranked first and corroborates
   nothing is recorded as `unverified`, never as the website.

   With many places, fan it out: `orchestrate --run <dir> --phase resolve`.

6. **Enrich in two tiers, and spend the second one deliberately.** Tier 1 reads
   the homepage and the legal notice on every corroborated site: four requests,
   and it answers whether the site is alive, what it says it does, whether the
   company runs a hiring pipeline, and whether its SIREN is published there.
   Tier 2 is the expensive one — a page per role (about, services, products,
   pricing, careers, team, contact, cases, news) plus the openings read
   straight out of the ATS API rather than out of a JavaScript shell. Run it on
   the ones you have a reason to care about, not on the whole town: a thousand
   places at eight pages each is six thousand requests and several hours.

7. **Rank, then judge.** `score` adds a measured total from things it counted —
   site alive, recently touched, roles open, headcount band, revenue filed,
   contactable. It does NOT score whether a company matches the brief, however
   the `--icp` text is phrased. That is yours: read the packets, then fold
   verdicts back with `score --apply '[{"id":"…","fit":"strong","why":"…"}]'`.
   `fit` sits beside `total`; it never overwrites it, so the one column nobody
   had to be trusted for stays intact.

8. **Write each dossier from its packet.** `dossier --id <id>` prints the fact
   sheet and the FULL TEXT of every page fetched for that company, each under
   the id you must cite. End each factual sentence with `[P3]`; mark your own
   inference `[M]`. Do not cite a page fetched for a different company — the
   gate checks ownership, not just existence.

9. **Run `check` before anyone reads the output.** Exit 1 means stop. It
   re-opens every citation, demands a source or an `[M]` on every factual line,
   and re-reads every email, phone and person against the page it claims to
   come from. That last rule is the one that matters: an address assembled from
   a naming convention is plausible, unfalsifiable at a glance, and will be
   emailed. The gate makes it impossible rather than discouraged.

10. **Render, and hand over what the render says.** `render` writes
    `PROSPECTS.csv` (flat, CRM-shaped, with `score` and `fit` in separate
    columns and each contact's source page beside it), `prospects.json`,
    `REPORT.md`, and a self-contained `index.html` that makes no network
    requests. If the run is truncated, both the report and the page lead with
    that — repeat it, do not paraphrase it away. If `PRIVACY.md` was written,
    the run holds named individuals and that file says what follows from it.

11. **Write from `places.json`.** Every field carries where it came from. A place
   with `sources: ["osm","sirene"]` has both records attached; a place with one
   source has one, and the other half is not "missing data" you may fill in.
   `website.confidence` is `corroborated`, `unverified` or `declared` (a mapper
   typed it into OSM and nobody has checked) — say which when it matters.

## When the run looks wrong

| Symptom | Cause |
|---|---|
| `where` exits 2 with a list | Working as designed. Several distinct places match; choose one. |
| Very few OSM places | Overpass mirrors were busy. `doctor` shows which answered; re-run. |
| `truncated: true` on the register lane | The territory exceeds the API's 10 000-result ceiling even after the NAF split, or `--max-results` was reached. Narrow the filters. |
| Register lane returned 0 outside France | Expected. The register is French; only the OSM lane applies. |
| A merged place looks like two companies | Adjudication was skipped or answered too generously. Check `matchConfidence` and the raw lanes in `osm.json` / `registry.json`. |
| Thousands of dormant one-person companies | Add `--min-employees`; ceased companies are already excluded unless `--include-ceased`. |
| `resolve` exits 2 saying no results were supplied | Working as designed. Run `--queries`, do the searching, pass `--web-results`. |
| A company's own domain shows as `unverified` | The page did not carry its name, address or SIREN. Often a JavaScript-only site — the evidence string says which. It is a candidate, not a confirmed site. |
| `enrich` says "no place has a corroborated website" | `resolve` has not run, or corroborated nothing. Enrichment only ever reads sites we proved belong to the company. |
| A company with a careers page shows `isHiring` unset | Deliberate. A board was detected but its openings could not be read, and "not hiring" would be a different claim. |
| `check` says a contact is not on its page | Believe it. Either the value was constructed, or the page changed since it was read. Both mean it must not ship. |
| `check` flags a line you consider obvious | It is a factual claim with no source. Cite the page, or mark it `[M]` and own it. |

## Do not

- Never present a run with `truncated: true` as a complete list of a territory.
- Never merge a `MATCH.todo.json` pair you cannot justify from its evidence.
- Never write a contact detail that is not verbatim in a fetched page or an
  open-data record, and never derive one from a naming pattern.
- Never describe the register lane's absence outside France as a failure.
- Never strip the ODbL and Licence Ouverte notices from a deliverable.
- Never re-run a sweep to "check" a number the manifest already reports — the
  upstreams move, and a second run answers a different question.
- Never treat a search result as a company's website. Rank is not evidence of
  ownership; only the fetched page corroborating itself is.
- Never present a run whose `check` exits non-zero. There is no "with caveats".
- Never turn the `--icp` text into a number. The engine refuses to; so should you.
- Never describe a `watch` disappearance as a closure. A company drops out of a
  sweep for half a dozen reasons; only the register can say a business ceased,
  and `DELTA.md` keeps the two apart for exactly that reason.

## Scope notes

- **Measured, not asserted.** Every count in the manifest is something the
  engine observed. Where an upstream refuses to say how much exists, the engine
  reports a floor and marks the lane truncated.
- **Determinism is a product guarantee.** The same fixture produces the same
  fusion, byte for byte. `--fixture` and `--record` exist so a pipeline can be
  tested without five live services in the loop.
- **Politeness is not optional.** Every upstream here is public infrastructure,
  three of them volunteer-run. The engine identifies itself, paces itself per
  host and honours robots.txt.

## Orchestration — route by harness

| You have | Do |
|---|---|
| The Workflow tool | `orchestrate --run <dir>`, then launch `orchestration/<phase>.workflow.mjs` |
| Subagents but no Workflow tool | `orchestrate --run <dir>`, dispatch each agent with the contract in `orchestration/agents/<role>.md` |
| Neither | `orchestrate --run <dir> --eco` and work down `RUNBOOK.md` yourself |

Three phases fan out — `resolve`, `match` and `dossier`. Searching for a
company's website is per-company thinking, and it is the phase the run rests on.
Enrichment is deliberately not one of them: reading those websites is I/O
against other people's servers, and parallelising it across subagents multiplies
the request rate while the per-host pacing only governs one process. **Fan-out
is an optimisation for thinking, never for fetching.**

Subagents never write; the folds stay with you, the orchestrator. Re-run
`orchestrate` whenever a worklist changes.

## References

| Open it when | File |
|---|---|
| You need an upstream's exact parameters, limits or failure modes | [references/data-sources.md](references/data-sources.md) |
| You are adjudicating pairs and want the scoring model | [references/matching.md](references/matching.md) |
| You are enriching, or wondering why hiring is unknown | [references/enrichment-playbook.md](references/enrichment-playbook.md) |
| You are ranking, writing a dossier, or reading a gate failure | [references/scoring-and-citations.md](references/scoring-and-citations.md) |
| A run behaved oddly, or you need exit codes and env vars | [references/operations.md](references/operations.md) |
| The deliverable will be shared, stored, or contains people | [references/privacy-and-licensing.md](references/privacy-and-licensing.md) |
