# The upstreams

None of these belong to us. Almost all are free, keyless and public; several are
volunteer-run. Everything here was measured against the live services, not read
off a spec sheet — where the two disagree, the measurement is recorded and the
code follows it.

**There is no fixed number of them.** The geocoders, Overpass and the ATS boards
are constant; the register connectors come from `CONNECTORS` in
`src/registry/index.ts`, one per country, and that same table drives `doctor`,
the manifest's attributions and the weekly canary. This page describes the
constants in full and then the shape every register connector shares.

## Nominatim — geocoding, worldwide

`https://nominatim.openstreetmap.org/search?format=jsonv2`

Called **once per run**, to turn a place name into a centre, a bounding box and
— the part nothing else provides — the OSM **relation id** of an administrative
area. That id is what lets the OSM lane search a commune's real boundary instead
of the rectangle around it.

- **1 request per second**, and an identifying `User-Agent` is required by
  policy. A generic one is grounds for blocking the address, for everyone
  behind it.
- Returns `boundingbox` as `[minLat, maxLat, minLon, maxLon]` **as strings**.
- `address.country_code` decides which register connectors apply, and whether
  any of them can sweep.
- Ambiguity is resolved by refusal: when a rival hit has comparable
  `importance` and sits more than 10 km away, `where` lists the candidates and
  exits 2.

## Base Adresse Nationale — French addresses

`https://api-adresse.data.gouv.fr/search/`

Runs only after Nominatim returns a French hit, and only to obtain
`properties.citycode` — the **INSEE commune code**. This is not the postcode and
the two are not interchangeable: 75015 is an arrondissement, 80021 is Amiens,
and the register indexes on the latter. Best-effort; a missing citycode costs
the register lane its sharpest filter but never blocks the run.

## Overpass — places, worldwide

`POST|GET /api/interpreter`, ODbL.

The only lane that works outside France, and the only source of the shopfront
detail — the sign over the door, the opening hours, and for roughly a fifth of
them the website that the whole enrichment stage grows from.

What counts as a business is an explicit nine-group catalogue: `shop`,
`office`, `craft`, `healthcare`, `industrial`, `amenity`, `tourism`, `leisure`
and `club`. Industrial coverage includes `man_made=works` and every feature
carrying an `industrial` tag. ATMs are excluded: they are machines, not
businesses, even when a bank operates them.

Contact details are DECLARED in the same sense as `website`: a mapper entered
them on the feature; the scan carries them without claiming they were fetched
from the business. Emails come from `email` and `contact:email`. Phones come
from `phone`, `contact:phone`, `contact:mobile`, `mobile` and
`contact:whatsapp`. Social profiles come from `contact:facebook`,
`contact:instagram`, `contact:linkedin`, `contact:twitter`, `contact:youtube`
and `contact:tiktok`. Each value cites the exact feature as `osm:n…`, `osm:w…`
or `osm:r…`, which lets `check` re-read these tags from the run's `osm.json`.

Three measured behaviours shape how it is called:

1. **The reference instance answers a browser User-Agent with HTTP 406.** Not a
   quirk — a deliberate anti-scraping measure. The same query returns 200 with
   `curl/8` and 406 with a Chrome string. This tool sends its own name, version
   and repository URL.
2. **Mirrors differ by an order of magnitude in queue time**, and the fastest
   one changes by the hour. The engine rotates through a list; the one that
   answered is recorded in `manifest.notes`.
3. **Some public endpoints serve a REGIONAL EXTRACT** while speaking the same
   protocol. `overpass.osm.ch` answers a query over Vincennes with 200 and an
   empty element list — indistinguishable, to anything checking only the status
   code, from "this town has no businesses". Only verified planet instances are
   in the rotation, and `doctor` probes each with a query over central Paris so
   a regional extract shows up as one.

**A point search is a disc in both lanes.** Overpass has no circle: `--radius
800m` is sent as the bounding SQUARE around the point, whose corners sit at
800·√2 ≈ 1131 m — 27% more area than was asked for, all of it in the corners.
The French register's `/near_point` does take a radius and returns a real disc.
So the OSM lane trims its own results back to the circle before fusion, and says
how many features it dropped in `manifest.notes`. Without that the two lanes
would cover different territories while the manifest called both of them
"radius", and a shop 1.1 km out would appear in one and be missing from the
other for no reason a reader could see.

Failures come in two kinds that both contain the word "timeout" and want
**opposite** responses: a saturated instance (`Dispatcher_Client`, `open64`, a
504) means try another mirror; a genuine overrun (`Query timed out in N
seconds`, `out of memory`) means quarter the area and retry. Conflating them
either hammers one busy host with four sub-queries or gives up on a perfectly
ordinary town.

## The register connectors

A connector DECLARES what it can do, and the pipeline reads the declaration:

| Capability | What it means | Who has it |
|---|---|---|
| `sweep` | Enumerate every company in a territory. **The SHAPE of the territory differs and the lane's `reason` names it**: France answers a bounding box, the UK a post town, Estonia an administrative unit. | France, United Kingdom, Estonia |
| `snapshot` | The register publishes everything as one bulk file and offers no queryable API. `ingest` reads this. | United Kingdom, Germany, Estonia |
| `lookup` | Find a company by name and locality. | most connectors |
| `verifyId` | Confirm an identifier read off the company's own site, and return what the register filed under it. | most connectors |

That table is not a design preference, it is what the world's open data
supports. Every other public register was probed and either needs a key, needs
credentials, or offers no geographic query at all. A connector with no `sweep`
is not a degraded sweep connector — it answers a different question, and
`LaneCoverage.mode` records which question was answered.

### Bulk exports, and why `ingest` exists

Two registers publish a file instead of an API. Both are keyless, both are too
large for a per-run path, and `ingest` fetches and indexes each once:

| | Companies House | OffeneRegister (Germany) | Äriregister (Estonia) |
|---|---|---|---|
| File | `BasicCompanyDataAsOneFile-YYYY-MM-01.zip`, ~470 MB | `de_companies_ocdata.jsonl.bz2`, 260 MB | `ettevotja_rekvisiidid__lihtandmed.csv.zip`, 18 MB |
| Freshness | monthly, "within 5 working days of the previous month end" — so `ingest` tries this month and falls back to the previous two | **frozen: the file dates from 2019-02, its records from 2017-2019** | **rebuilt daily** |
| Licence | Open Government Licence v3.0 | CC-BY 4.0, attribution to OpenCorporates | Estonian open data |
| Rows | 5 695 465 (measured) | 5 305 727 (measured) | 376 025 (measured) |
| Disk after indexing | **~4.2 GB** (measured) | **~3.4 GB** (measured) | **~640 MB** (measured) |
| Gives | a real `sweep` by post town, plus keyless `lookup`/`verifyId` | `lookup`/`verifyId`, and **the holder of an HRB number** | a real `sweep` by administrative unit, plus `lookup`/`verifyId` by register code OR VAT number |

`ingest --list` reports what is cached, its vintage and its size on disk. `ingest
--country <cc> --forget` deletes one.

Records from a snapshot carry **`asOf`** — the date they were true — UNLESS the
source is rebuilt often enough that they are simply current, which Estonia's daily
file is. Absent means live. It travels into the CSV, the dossier fact sheet and the report, and
`check` will not let a dated record found a present-tense claim. That single field
is what makes a seven-year-old German export usable rather than misleading: "was
registered at, as of 2018-07" is a fact; "is registered at" is not one this run
can support.

Each connector also carries its own `canary()`, asserting the response shape ITS
parser depends on. Adding a country therefore adds its drift detection, with
nothing to remember elsewhere.

### What each one will not do

- **eu-vies** — all 27 member states, keyless. Confirms that a VAT number is a
  live intra-community registration. **Germany and Spain answer `"---"` for the
  trader's name**, so a number can be confirmed without its holder being
  disclosed. It also does not know a number that was never enabled for
  intra-EU trade, which is most small traders — that is not evidence the number
  is wrong, and the run says so. `MS_UNAVAILABLE` is a member state's own outage
  and is reported as inconclusive, never as invalid.
- **gleif** — worldwide, keyless, and the only keyless route from a German
  `HRB` number to a filed identity (`entity.registeredAs`). Covers entities
  holding an LEI, roughly 2.7 million against tens of millions of companies: it
  will know a bank and not the bakery next door. German register numbers repeat
  across courts, so an exact number match is checked against the name too.
- **gb-companies-house** — two routes, and the keyless one is primary. The
  monthly Free Company Data Product needs no key at all and, once ingested,
  enumerates a post town: that is a real sweep, and the lane's `reason` says in
  words that a post town is not a bounding box, so it does not coincide with the
  OSM lane's geometry. The REST API needs a free key (email only), is a day
  fresher, and is never required — no successful response from it has ever reached
  this code, which the connector declares in `unverified` and `doctor` prints.
  A UK registered office is very often the company's accountant, so an address
  from here is the register's address and not necessarily the premises, and the
  postcode is deliberately never used to narrow a lookup.

  **Two SIC codes are not activities.** UK SIC 2007 is NACE-derived, so its first
  two digits are the NACE division — except at the top of the range, where the UK
  added administrative codes: `99999` is "dormant company" and `98000` is
  "residents property management". Division 99 exists in NACE, so mapping `99999`
  through produced section U, "activities of extraterritorial organisations" —
  fourteen dormant shells in one small town, and `--section U` would have returned
  them. Both now resolve to NO section and are reported under the register's own
  words. A dormant company in a prospect list is worth seeing; an extraterritorial
  organisation in Hebden Bridge is a fabrication.
- **ee-ariregister** — keyless, 18 MB, and the FRESHEST register here: the export
  is rebuilt daily, so its records carry no `asOf`. It sweeps by administrative
  unit, and every level of the hierarchy is indexed — Estonia files Tallinn's
  companies under its eight districts, never under "Tallinn", so indexing only the
  full string would make a sweep of the capital return nothing while 59 000
  companies sit in Kesklinn alone. Three traps in the file itself: it is
  SEMICOLON-separated (every Estonian address contains commas), it carries a UTF-8
  BOM (which turns the first column's name into `\uFEFFnimi` and every company
  arrives nameless), and status is a letter where `L` (in liquidation, 9 052
  companies) and `N` (bankrupt, 666) are neither active nor struck off — the
  register's own word is kept in `national.statusText`. No activity code: EMTAK
  lives in a separate export, so no scheme is declared rather than one invented.
- **de-offeneregister** — keyless, from the ingested export, and the only source
  here that will tell you WHO holds a German `HRB` number. Data stops in 2019, so
  every record carries `asOf` and it declares no `sweep`: a 2018 enumeration
  presented as a Berlin district's businesses would be the lie this tool exists to
  refuse. 61% of the export is companies the register has since removed, which is
  mapped as `ceased` rather than defaulted to active. A bare register number is
  refused when more than one Amtsgericht has it — supply the court from the
  Impressum and it is matched exactly.
- **no-brreg** — keyless, and the richest after France's: an EXACT headcount
  (`antallAnsatte`) rather than a band, and the company's own website
  (`hjemmeside`), which is otherwise something `resolve` has to go and prove.
- **fi-prh** — keyless. `status` is `"2"` for live companies AND dissolved ones;
  it means "registered in YTJ", not "trading". Liveness comes from `endDate` and
  `tradeRegisterStatus`. Names arrive as a full history, so an expired name is
  kept for matching and never printed as the company's identity.
- **cz-ares** — keyless, name search by POST. `czNace2008` is ragged: 5-digit,
  3-digit and placeholder codes appear in one record.
- **pl-krs** — keyless, **lookup by KRS number only**. The public API has no
  name search, so the connector declares `verifyId` and nothing else.
- **us-edgar** — keyless, and the narrowest here: the only stable name→CIK route
  is `company_tickers.json`, which lists companies with a traded ticker, about
  10 400. Whole Foods is not in it. It also **rejects a User-Agent containing a
  URL** with 403 and wants a bare `name email`, making it the one upstream that
  refuses this tool's normal polite string.

### recherche-entreprises — the French register, and the only sweepable one

`https://recherche-entreprises.api.gouv.fr`, Licence Ouverte 2.0, 7 req/s, no key.

Two endpoints:

- `/search` — `code_commune`, `code_postal`, `departement`, `region`, `epci`,
  `activite_principale`, `section_activite_principale`, `tranche_effectif_salarie`,
  `nature_juridique`, `etat_administratif`, `categorie_entreprise`,
  `ca_min`/`ca_max`, and more. `nature_juridique=9110,5710` is an include list;
  the API has no negation, so `--exclude-legal-form` is client-side.
- `/near_point` — `lat`, `long`, `radius` (**≤ 50 km**), plus the two activity
  filters. Nothing else; legal-form includes and exclusions are both re-applied
  client-side there.

### Three ceilings, one of them undocumented

**`per_page` ≤ 25**, and **`page × per_page` ≤ 10 000** — documented. Walk past
it and the API answers with an empty page, then a 400 that says so.

**`total_results` is CLAMPED at 10 000** — not documented, and the important
one. Asking for every legal unit in Vincennes reports exactly 10 000; summing
the same query across the 21 NACE sections reports **37 717**. The field is a
floor, never a count. Any code that reads 10 000 as "the total" silently loses
two thirds of a town.

The lane therefore treats `>= 10 000` as "at least this many" and splits: first
by **NACE section** (21 parts — usually enough; the largest section in a French
commune runs to a few thousand), then by **NACE division** inside the section. A
leaf that still reports the cap is recorded as truncated with its reason.

The result budget is a third ceiling. When the whole-query probe exceeds
`--max-results`, the lane spends 21 extra requests probing every NACE section
with `per_page=1` before it drains any of them. It records those totals and
water-fills the budget across the sections, carrying capacity unused by small
sections to the larger ones. The result is a declared per-section sample, not
the old alphabetical prefix and not the whole territory.

`activite_principale` accepts **only full codes** (`62.01Z`); a `62` prefix is
rejected. Conveniently, the rejection lists every valid code — which is where
`src/naf.ts` comes from, regenerated by `node scripts/refresh-naf.mjs`.

### `/near_point` silently ignores what it does not implement

Sending `etat_administratif=A` to the point endpoint changes nothing: the count
comes back identical. It is not rejected, it is dropped. So filters that only
`/search` implements are applied client-side after the fetch, and nothing
assumes a parameter took effect because the request was accepted.

### Every filter matches the LEGAL UNIT, never the establishment

This catches everyone once. `section_activite_principale`, `tranche_effectif_salarie`
and `etat_administratif` all filter the company; `matching_etablissements` then
returns its establishments with their own, different values. Orange is a telecom
operator (61.10Z, section J, 10 000+ staff) and its Vincennes establishment is a
phone shop (47.42Z, section G, 10-19 staff). **Both are true.** A `--section J`
run returning a section-G shop is the API being precise, not broken.

So a record carries both: `nafCode`/`effectifTranche` are the ESTABLISHMENT's —
this tool's unit is the place — and `company.nafCode`/`company.effectifTranche`
are the legal unit's, which is what the filters matched and what the score uses
for company size. The fact sheet and the CSV show both whenever they differ.

The establishment's own `etat_administratif` is filtered client-side regardless
of endpoint: an active company keeps its closed branches, and without that a
restaurant that shut in 2019 appears as an open one at a real address. On
Vincennes it is the difference between 672 rows and 348.

### Establishments, not legal units

One company is one legal unit and any number of establishments. This tool's unit
is the **place**, so each `matching_etablissements` entry becomes its own record:
a chain with four branches on one high street is four prospects at four
addresses, not one head office in another département. Only the `siege` object
carries a pre-parsed address; branch addresses arrive as one raw string and go
through the address parser.

## The ATS job boards

Public, keyless JSON, used by the enrichment stage to read openings without
executing a page's JavaScript. They decide whether `isHiring` is a finding or an
absence, so the weekly canary asserts their shape: a board that changed silently
makes every company on it read as not hiring.

- Greenhouse — `https://boards-api.greenhouse.io/v1/boards/<token>/jobs`
- Lever — `https://api.lever.co/v0/postings/<company>?mode=json`
- Ashby — `https://api.ashbyhq.com/posting-api/job-board/<name>`

The board token is discovered from links on the company's own careers page, so
nothing is guessed from the company name.
