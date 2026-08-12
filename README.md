# ultraprospect

**Turn a place into a prospect list you can defend.** Give it a town, a street
or a radius; it sweeps OpenStreetMap worldwide, attaches whatever company
register the country actually has — France, the UK and Estonia can be enumerated
outright, none of them needing a key — and refuses to guess where guessing would
be invisible.

Zero dependencies, no API keys, no install. One vendorable `engine.mjs`, a CLI,
and a [skills.sh](https://skills.sh) agent skill. The web-retrieval half is
[webindex](https://github.com/maxgfr/webindex), vendored and pinned.

```bash
ultraprospect where "Vincennes" --country fr     # resolve the place, or refuse to
ultraprospect scan  --where "Vincennes" --country fr
```

```
  OSM              1069
  register         672  (fr-sirene)
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
| **Register** | whichever register the country has — see below | the legal identity, the activity code, the size, the directors |

Neither half is a prospect on its own. A shopfront with no legal identity cannot
be qualified; a registered company with no address on the street cannot be
visited. The value is the join — and the join is where a tool like this usually
starts lying, so it is where most of the care went.

## What the register lane can actually do, per country

Measured against the live services, and the single most important thing to
understand about a run:

**Three public registers can be enumerated without an API key, and no two are
enumerated the same way.** France's answers a bounding box over an API. The United
Kingdom's publishes a monthly open-data snapshot of every live company — 470 MB of
zipped CSV, no key, no registration — which `ingest` fetches once and which files
each company under its registered office's POST TOWN. Everywhere else a register
can confirm a company you already found, and nothing more.

So there are three shapes of register lane, and the manifest always says which one
you got — `mode` is a column in the report's Coverage table:

| Mode | What it means | Where |
|---|---|---|
| **sweep**, by area | The register was asked for every company inside the bounding box. The answer is a territory. | France |
| **sweep**, by post town | The monthly snapshot holds every company the register files under that post town. A real enumeration, and **a post town is not a bounding box** — so it does not coincide with the OSM lane's geometry, and a company registered at its accountant's address in the next town is absent. | United Kingdom, after `ingest --country gb` |
| **sweep**, by administrative unit | Estonia files companies by district, city and county, and every level is indexed — so both "Kesklinna linnaosa" and "Tallinn" resolve. Rebuilt **daily**, so its records need no date. | Estonia, after `ingest --country ee` |
| **confirm** | OSM covered the ground; each company was then checked against the register one at a time. **A company absent from OpenStreetMap is absent from the run.** | everywhere else |

```bash
# France — the register is swept alongside OSM
ultraprospect scan --where "Vincennes" --country fr

# Germany — OSM sweeps, then the register confirms company by company
ultraprospect scan    --where "Kreuzberg, Berlin" --country de
ultraprospect resolve --run <dir> --web-results hits.json
ultraprospect enrich  --run <dir> --tier 1     # fetches the Impressum
ultraprospect confirm --run <dir>              # reads it, asks the authority
```

### The connectors

| Country | Register | Key | What it can do |
|---|---|---|---|
| France | `recherche-entreprises.api.gouv.fr` (Sirene/RNE) | none | **sweep** by area, lookup, verify |
| United Kingdom | Companies House — monthly open-data snapshot | none | **sweep** by post town, lookup, verify — after `ingest --country gb` |
| United Kingdom | Companies House REST API | free, email only | lookup, verify — a day fresher than the snapshot, and never required |
| Germany | Handelsregister via the OffeneRegister export | none | lookup, verify — **and it names the HRB holder VIES will not**. Data stops in 2019; every record carries `asOf`. After `ingest --country de` |
| Estonia | Äriregister open data | none | **sweep** by administrative unit, lookup, verify — 18 MB, **rebuilt daily**, 376 025 companies. After `ingest --country ee` |
| Norway | Enhetsregisteret (Brønnøysund) | none | lookup, verify — exact headcount and the company's own website |
| Finland | PRH / YTJ | none | lookup, verify |
| Czechia | ARES | none | lookup, verify |
| Poland | KRS | none | verify only — the public API has no name search |
| United States | SEC EDGAR | none | lookup, **listed companies only** |
| EU-27 | VIES | none | verify a VAT number |
| worldwide | GLEIF | none | lookup, verify — entities holding an LEI |

**Spain and the United States have no open register to sweep or search, and
Germany has no official one.** What Germany and Spain have instead is the law:
`enrich --tier 1` fetches the legal notice every company there is required to
publish (`Impressum`, § 5 DDG; `aviso legal`, Ley 34/2002), `confirm` reads the
registration number off it, and an authority is asked whether that number is
real and whose it is.

Germany also has something unofficial and genuinely useful. The Handelsregister
is 150 databases held by local courts, free to search at handelsregister.de since
2022 and offered through no API at all; what exists as open data is one export
published by the Open Knowledge Foundation Deutschland with OpenCorporates —
4.5 million companies and their officers, CC-BY 4.0. Two measured facts decide how
it is used:

- **It names the holder of an HRB number**, which is precisely what VIES refuses
  to do for Germany. That is the gap it closes and the reason it is here.
- **It stopped in 2019.** Its SQL API is gone (502) and its records were retrieved
  between 2017 and 2019, each stamped with its own date. So every record carries
  `asOf`, it declares no `sweep` — an enumeration from 2018 presented as the
  businesses in a Berlin district would be the exact lie this tool refuses — and
  the gate will not let a dated record found a present-tense claim.

So a German run has two independent register answers, and they answer different
questions: VIES says a VAT number is live TODAY without saying whose, and the
export says who filed under an HRB number THEN. Neither alone is a current
identity. Together they are worth more than either, as long as both dates are
stated.

What the authorities will not say is reported rather than smoothed over:

- **VIES does not name the holder for Germany or Spain.** It answers `"---"`.
  A number can be confirmed live without its owner being disclosed, and that is
  recorded as an attested identifier, never as an identity.
- **A German register number is not an identity without its court.** `HRA 4792`
  exists at several Amtsgerichte — GLEIF once resolved one to a company in another
  Land. The export carries the court, so a number qualified by its Amtsgericht is
  matched exactly and a bare one is refused when more than one court has it.
- **VIES only knows numbers enabled for intra-community trade.** A small
  trader's perfectly legitimate VAT number is unknown to it, and the run says so
  rather than implying the page is lying.
- **GLEIF covers entities holding an LEI** — roughly 2.7 million worldwide. It
  resolves a German `HRB` number to a filed identity, which nothing else keyless
  does, and it will not know the bakery next door.
- **The United States has no federal company register and publishes no company
  number.** An EIN is never disclosed. A US run rests on address and name, and
  `confirm` says so rather than reporting a failure to find something that does
  not exist.

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
else's registration — invisible forever.

**It refuses to call a partial sweep complete.** Every lane reports its own
coverage and its own `mode`, both as columns in the report's table, and a
confirmed territory is never presented as a swept one — the report's opening
sentence is DERIVED from the lanes rather than asserted, so there is no code path
that can claim a sweep the run did not perform. `manifest.truncated` is the
headline, and the report leads with it.

**It dates what came out of a snapshot.** A record carrying `asOf` is a fact about
that date, not about today, and the gate will not let one found a present-tense
claim. That is what makes a seven-year-old German register export usable instead of
misleading.

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

**It refuses a registration it cannot re-read.** A legal identifier that
`confirm` turned into an identity must still be findable in the page it cites,
or the identity built on it does not ship.

**It refuses to say "not hiring" when it could not look.** A company with no
careers page and no board is not hiring — a finding. A company whose board
exists but has no readable API is *unknown*. Those are different facts and the
CSV keeps them in different states.

## Things measured, not assumed

Everything here came from calling the live services, and none of it is what the
documentation says:

- **The French register clamps `total_results` at 10 000.** Asking for every
  legal unit in Vincennes reports exactly 10 000; summing across the 21 NACE
  sections reports **37 717**. Treating that field as a count silently loses two
  thirds of a town. The lane treats it as a floor and splits by section, then by
  division.
- **`/near_point` ignores filters it does not implement** rather than rejecting
  them. `etat_administratif=A` changes nothing there. Those filters are applied
  client-side; nothing assumes a parameter took effect because the request was
  accepted.
- **A French legal unit closes with "C", an establishment with "F".** Reading
  only A and C reported every closed office as "unknown", which downstream is
  indistinguishable from "we did not look".
- **VIES answers `isValid: false` together with `MS_UNAVAILABLE`** when a member
  state's own system is down. Reading that as "invalid" reports somebody else's
  outage as a fact about a company.
- **Finland's `status` is "2" for live and dissolved companies alike.** It means
  "registered in YTJ", not "trading". Reading it as liveness reported Nokia as
  ceased.
- **SEC EDGAR refuses a User-Agent containing a URL** with 403 "Your Request
  Originates from an Undeclared Automated Tool", and serves a bare
  `name email`. It is the one upstream here that rejects this tool's polite
  identifying string.
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
| `ingest --country` | Fetch and index a register's bulk open-data export. Once; then every query is local. `--list` says what is cached. |
| `scan` | Sweep OSM over the area, and the register too where one can be swept. |
| `match --apply` | Fold an adjudication of `MATCH.todo.json` back into the run. |
| `confirm` | Attach a register identity company by company, where no sweep exists. |
| `resolve` | Find each company's website and prove it is theirs. |
| `enrich --tier 1\|2` | Read those sites; tier 2 also reads the openings from the ATS APIs. |
| `score` | Rank by measured signals; fold your ICP verdicts in with `--apply`. |
| `dossier --id` | The grounding packet for one company: fact sheet plus every page, in full. |
| `check` | The gate. Exit 1 means do not present the output. |
| `render` | `PROSPECTS.csv`, `prospects.json`, `REPORT.md`, a self-contained `index.html`. |
| `watch --since` | What moved: who opened, closed, started hiring, gained a site. |
| `orchestrate` | Fan the search and judgement phases out across subagents. |
| `mcp` | Serve it over MCP: where, ingest, scan, places, confirm, enrich, score, dossier, check, render, watch, doctor. The two `--apply` folds and `resolve` stay CLI-only, on purpose. |
| `doctor` | Check every upstream. `--country` narrows the register probes. |

### A run, end to end

```bash
ultraprospect where   "Vincennes" --country fr             # or refuse, and list the candidates
RUN=$(ultraprospect scan --where "Vincennes" --country fr --min-employees 20)
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
ultraprospect scan --where "Lyon" --section M --min-employees 20
ultraprospect ingest --country gb                         # once: 470 MB, no key
ultraprospect scan --where "Hebden Bridge" --country gb   # the UK register, enumerated
ultraprospect ingest --country ee                         # 18 MB, rebuilt daily
ultraprospect scan --where "Tartu" --country ee            # Estonia, enumerated
ultraprospect scan --lat 52.5389 --long 13.4244 --radius 350m --country de
ultraprospect scan --where "Nantes" --no-people          # organisation data only
ultraprospect scan --record ./fixtures/x                 # record a replayable sweep
ultraprospect scan --fixture ./fixtures/x                # replay it, fully offline
```

`--section J,M` means the same thing in Lyon, Berlin, Madrid and Manchester:
NAF, WZ, CNAE and UK SIC are all NACE-derived and agree down to the division. It
does **not** mean the same thing in Austin — US SIC divisions are also lettered
A–K and stand for different industries — so a section never travels without its
scheme.

`--help` is the full surface and a build gate keeps it in sync with the code.

## The run

```
.ultraprospect/runs/<slug>-<id>/
  manifest.json      target, filters, per-lane coverage and mode, counts, notes, licences
  osm.json           raw OSM lane output, kept beside the fused result
  registry.json      raw register output, whichever connectors answered
  places.json        the fused entities
  MATCH.todo.json    pairs the matcher would not decide alone
```

## Licensing of the data

Output derived from these sources carries their notices — an ODbL condition, not
a courtesy. The manifest hands you the exact strings, and **only for the
connectors that actually answered**: a German run does not claim France's
Licence Ouverte.

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
and pushes only when they all pass. `src/classification/naf-codes.ts` is
generated from the French register's own validation error by
`node scripts/refresh-naf.mjs`.

Adding a country is one file under `src/registry/` and one entry in
`CONNECTORS`. That table is read by the sweep lane, `confirm`, `doctor`,
`manifest.licences` and the weekly canary, so a new connector arrives with its
own drift detection and nothing to remember.

MIT.
