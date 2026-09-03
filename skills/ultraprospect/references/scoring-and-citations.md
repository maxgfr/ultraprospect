# Ranking, writing, and the gate

## Two halves, kept apart

`score` is arithmetic over things the engine measured. `fit` is what a person
decided. They live in separate columns and the second never overwrites the
first, because the measured number is the only one in the file that nobody had
to be trusted for.

The engine will not score fit, however the `--icp` text is phrased. A model
asked to turn "agencies that are growing" into a number will produce one, and it
will look exactly like a measurement.

### What the measured half counts

| Term | Weight | When |
|---|---:|---|
| `hasSite` | 10 | the website is **corroborated**, not merely claimed |
| `siteWorks` | 5 | it was reachable when we fetched it |
| `fresh` | 15 | decaying linearly over 180 days from the newest sitemap `lastmod` |
| `depth` | 5 | one point per page read, capped |
| `hiring` | 15 | openings were actually read |
| `openRoles` | 2/role | capped at five roles |
| `size` | 12 | log of the headcount band's floor, saturating |
| `revenue` | 8 | log of filed revenue, saturating |
| `registered` | 8 | a register confirmed the company, whether by sweep or by `confirm` |
| `contactable` | 10 | a published email or phone exists |
| `ecommerce` / `pricing` | 4 each | sells online / publishes prices |

Hiring and freshness dominate because they answer the only question a
prospecting list is really asking: is this company spending money right now. A
fifty-person company with a dead website is a worse prospect than a six-person
one that just posted three roles.

Two absences are treated as unknown rather than as zero: a site with no `lastmod`
is not stale, and a headcount band of `NN` is not "no employees".

### Folding your verdict in

```bash
ultraprospect score --run <dir> --apply '[{"id":"osm:n1","fit":"strong","why":"…","angle":"…"}]'
```

`fit` is one of `strong · possible · weak · no`. Ranking puts verdicts ahead of
the measurement — and an explicit `no` ranks **below** an unjudged place, so
working through the list does not promote the rows you already rejected.

## The citation grammar

Every factual sentence in a dossier ends with the id of the page it came from.

```
Les Officiers is a café-restaurant on Avenue de Nogent. [P5]
The site is small — seven pages, newest entry April 2026. [P6][P7]
A single-site restaurant with a dated website is a plausible target. [M]
```

- `[P5]` — this sentence comes from stored page P5.
- `[P1][P4]` — from both.
- `[M]` — your own inference. The Angle paragraph is where this belongs.

The `from` field on a sourced value uses the source's own address: `P3` for a
stored fetched page, `osm:n248494308` (or `osm:w…` / `osm:r…`) for a feature in
the run's `osm.json`, a direct URL when the URL itself is the cited source, or a
lane name such as `registry` for open register data. These forms are provenance
in `places.json`; only stored page ids use the dossier's `[P#]` grammar.

Structure is exempt: headings, separators, short bullet labels, block quotes,
table rows and fenced code make no claims. Demanding ids on them would teach
whoever writes the dossier to sprinkle ids to silence the gate, and then the ids
stop meaning anything.

## What `check` refuses

Errors — the run fails, exit 1:

| Rule | What it catches |
|---|---|
| `citation-unresolved` | a `[P#]` no stored page has |
| `citation-foreign` | a page fetched for a **different** company |
| `claim-uncited` | a factual sentence with no `[P#]` and no `[M]` |
| `contact-not-on-page` | an email, phone or person that does not appear in the page it claims to come from |
| `contact-unsourced` | a contact attributed to a page this run does not hold |
| `dossier-orphan` | a dossier filename that maps to no place |

Warnings — reported, do not fail: a truncated run, a site that went unreachable,
a website candidate that corroborated nothing, places enriched but not written up.

### The contact rule is the important one

An address assembled from a naming convention is plausible, unfalsifiable at a
glance, and will be emailed. `cyril.kolodziejski@lesofficiers.fr` — real
director from the register, real domain, attributed to a page that really was
fetched — is exactly what this rule exists to stop, and it does:

```
FAIL  contact-not-on-page   osm:n452420246 · email cyril.kolodziejski@lesofficiers.fr
      does not appear in P3. Either it was constructed, or the page changed
      since it was read — both mean it must not ship.
```

Comparison is by value, not by formatting: a phone stored as `0143283007` and
written on the page as `01.43.28.30.07` matches.

## Fanning it out

Three phases, all judgement or search rather than bulk retrieval:

```bash
ultraprospect orchestrate --run <dir>          # emits both, plus the runbook
ultraprospect orchestrate --run <dir> --list   # which phases are ready
ultraprospect orchestrate --run <dir> --eco    # runbook and contracts only
```

- **resolve** — search for each company's website, 12 per agent. The phase the
  run rests on: skipped, a Vincennes sweep corroborated 11 sites out of 1164.
- **match** — adjudicate the undecided pairs, 20 per agent.
- **dossier** — one company per agent; a packet carries the full text of every
  page fetched for it, so two per context mostly means running out of room
  halfway through the second.

Enrichment is deliberately not a phase. Searching is per-company thinking;
READING the sites is I/O against other people's servers, and spreading that
across subagents multiplies the request rate while the per-host pacing only
governs one process. **Fan-out is an optimisation for thinking, never for
fetching.**

Subagents never write to the run. They return a fragment; you fold it — with
`match --apply`, or by saving the dossier and running the gate. One writer,
always. Re-run `orchestrate` whenever a worklist changes.
