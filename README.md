# ultraprospect

**Turn a place into a prospect list you can defend.** Give it a town, a street
or a radius; it sweeps OpenStreetMap worldwide and the French company register
for the same territory, fuses the two into one entity per company, and refuses
to guess where guessing would be invisible.

Zero dependencies, no API keys, no install. One vendorable `engine.mjs`, a CLI,
and a [skills.sh](https://skills.sh) agent skill. The web-retrieval half is
[webindex](https://github.com/maxgfr/webindex), vendored and pinned.

```bash
ultraprospect where "Vincennes" --country fr     # resolve the place, or refuse to
ultraprospect scan  --where "Vincennes" --country fr
```

```
  OSM              1069
  register         672
  fused places     1567  (174 matched across both lanes)
  with a website   215
```

---

## The problem

Building a prospect list for an area means opening a map, copying names into a
spreadsheet, and then visiting each website by hand. It is slow, it is not
reproducible, and the result carries no evidence: six weeks later nobody can say
where a row came from or whether the list ever covered the whole area.

The tempting fix — ask a model — is worse. A language model will happily produce
forty plausible companies for a town it has never seen, with plausible
addresses and plausible contacts. Nothing in the output looks wrong.

## The approach

Two lanes over the same territory, fused, with every fact carrying its origin.

| Lane | Source | Gives you |
|---|---|---|
| **Places** | OpenStreetMap via Overpass, worldwide, ODbL | the sign over the door, category, opening hours, and for ~1 in 5 a website |
| **Register** | `recherche-entreprises.api.gouv.fr` (Sirene/RNE), France, Licence Ouverte | SIREN/SIRET, NAF activity code, employee band, directors, filed revenue |

Neither half is a prospect on its own. A shopfront with no legal identity cannot
be qualified; a registered company with no address on the street cannot be
visited. The value is the join — and the join is where a tool like this usually
starts lying, so it is where most of the care went.

## What it refuses to do

These are features, and they are the reason the output is worth anything.

**It refuses an ambiguous place.** `where "Vincennes"` exits 2 and lists the
candidates, because Vincennes is a Paris suburb *and* a town in Indiana.
Silently picking the more "important" one produces a complete, plausible,
entirely wrong file that nothing downstream can detect.

**It refuses to merge an uncertain pair.** Matching is identity-dominant:
proximity can confirm a name but never substitute for one, because a Paris
office block holds fifty registered companies inside twenty metres. Pairs in the
middle band go to `MATCH.todo.json` with their evidence, for a human or an agent
to adjudicate. A wrong merge produces one plausible company holding somebody
else's SIREN — invisible forever.

**It refuses to call a partial sweep complete.** Every lane reports its own
coverage. `manifest.truncated` is the headline, and the report leads with it.

**It refuses to invent a contact.** Every email, phone number and person must
appear verbatim in a fetched page or an open-data record. No address is ever
derived from a `firstname.lastname@` pattern — and this is enforced rather than
intended. The gate re-reads each value against the page it claims to come from:

```
FAIL  contact-not-on-page   osm:n452420246 · email cyril.kolodziejski@lesofficiers.fr
      does not appear in P3. Either it was constructed, or the page changed
      since it was read — both mean it must not ship.
```

Real director from the register, real domain, real fetched page. Rejected.

**It refuses to say "not hiring" when it could not look.** A company with no
careers page and no board is not hiring — a finding. A company whose board
exists but has no readable API is *unknown*. Those are different facts and the
CSV keeps them in different states.

## Things measured, not assumed

Everything here came from calling the live services, and three of them
contradict what you would reasonably expect:

- **The register clamps `total_results` at 10 000.** Asking for every legal unit
  in Vincennes reports exactly 10 000; summing across the 21 NAF sections
  reports **37 717**. Treating that field as a count silently loses two thirds
  of a town. The lane treats it as a floor and splits by NAF section, then by
  division.
- **`/near_point` ignores filters it does not implement** rather than rejecting
  them. `etat_administratif=A` changes nothing there. Those filters are applied
  client-side; nothing assumes a parameter took effect because the request was
  accepted.
- **`etat_administratif` filters the legal unit, never the establishment.** An
  active company keeps its closed branches, and they arrive inside
  `matching_etablissements` looking like open businesses at real addresses.
  Filtering the establishment's own state drops a Vincennes sweep from 672
  register rows to 348 — nearly half of it was shut.
- **`overpass-api.de` answers a browser User-Agent with HTTP 406** — deliberate
  anti-scraping. And several public Overpass endpoints serve a *regional
  extract* while speaking the same protocol: `overpass.osm.ch` answers a query
  over Vincennes with 200 and zero elements, which reads downstream as "this
  town has no businesses". Only verified planet instances are in the rotation,
  and `doctor` probes each one for planet coverage rather than for a 200.

## Install

As an agent skill:

```bash
npx skills add maxgfr/ultraprospect
```

Or run the bundle directly — it is one dependency-free file, Node 18+:

```bash
node scripts/ultraprospect.mjs --help
```

## Commands

| Command | What it does |
|---|---|
| `where <query>` | Resolve a place to a search area. Exits 2 with candidates when ambiguous. |
| `scan` | Sweep both lanes over the area and fuse them. |
| `match --apply` | Fold an adjudication of `MATCH.todo.json` back into the run. |
| `resolve` | Find each company's website and prove it is theirs. |
| `enrich --tier 1\|2` | Read those sites; tier 2 also reads the openings from the ATS APIs. |
| `score` | Rank by measured signals; fold your ICP verdicts in with `--apply`. |
| `dossier --id` | The grounding packet for one company: fact sheet plus every page, in full. |
| `check` | The gate. Exit 1 means do not present the output. |
| `render` | `PROSPECTS.csv`, `prospects.json`, `REPORT.md`, a self-contained `index.html`. |
| `watch --since` | What moved: who opened, closed, started hiring, gained a site. |
| `orchestrate` | Fan the two judgement phases out across subagents. |
| `mcp` | Serve it over MCP: where, scan, places, dossier, check. |
| `doctor` | Check every upstream, including Overpass planet coverage. |

### A run, end to end

```bash
ultraprospect where   "Vincennes" --country fr             # or refuse, and list the candidates
RUN=$(ultraprospect scan --where "Vincennes" --country fr --min-effectif 20)
ultraprospect resolve --run "$RUN" --queries                # the queries for YOU to search
ultraprospect resolve --run "$RUN" --web-results hits.json  # ingest, fetch, corroborate
ultraprospect enrich  --run "$RUN" --tier 1
ultraprospect enrich  --run "$RUN" --tier 2 --limit 20
ultraprospect score   --run "$RUN"
ultraprospect dossier --run "$RUN" --id <id>                # write it up, cite [P#]
ultraprospect check   --run "$RUN"                          # must exit 0
ultraprospect render  --run "$RUN"
```

```bash
ultraprospect scan --where "Lyon" --section M --min-effectif 20
ultraprospect scan --lat 48.8566 --long 2.3522 --radius 500m
ultraprospect scan --where "Berlin" --no-sirene          # outside France, OSM only
ultraprospect scan --where "Nantes" --no-people          # organisation data only
ultraprospect scan --record ./fixtures/x                 # record a replayable sweep
ultraprospect scan --fixture ./fixtures/x                # replay it, fully offline
```

`--help` is the full surface and a build gate keeps it in sync with the code.

## The run

```
.ultraprospect/runs/<slug>-<id>/
  manifest.json      target, filters, per-lane coverage, counts, notes, licences
  osm.json           raw OSM lane output, kept beside the fused result
  sirene.json        raw register lane output
  places.json        the fused entities
  MATCH.todo.json    pairs the matcher would not decide alone
```

## Licensing of the data

Output derived from these sources carries their notices — an ODbL condition, not
a courtesy. The manifest hands you the exact strings.

```
Places and tags: © OpenStreetMap contributors, ODbL
French company data: base Sirene / RNE via recherche-entreprises.api.gouv.fr, Licence Ouverte 2.0
```

If your file contains named people, you are a data controller. See
[references/privacy-and-licensing.md](skills/ultraprospect/references/privacy-and-licensing.md);
`--no-people` strips them at scan time, before anything is written.

## Development

```bash
pnpm install
pnpm test              # unit suite, no network — a live call throws
pnpm run eval          # offline pipeline eval over a recorded sweep
pnpm run eval:network  # upstream canaries, opt-in
pnpm run check:build   # the committed bundle matches the source
```

The vendored webindex engine is pinned by tag and SHA-256 in
`src/vendor/webindex.meta.json`; a daily workflow re-pins it, runs every gate,
and pushes only when they all pass. `src/naf.ts` is generated from the
register's own validation error by `node scripts/refresh-naf.mjs`.

MIT.
