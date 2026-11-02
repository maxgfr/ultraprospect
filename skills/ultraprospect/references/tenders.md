# Public tenders — sources, coverage, measured limits

Everything here was measured against the live services on 2026-11-02. The
connector table is `src/tenders/index.ts`; `doctor` probes each source and
the weekly network eval runs one canary per source.

## What each source can answer

| Source | Countries | Coverage | Notices | Key |
|---|---|---|---|---|
| `fr-boamp` — BOAMP (DILA) on Opendatasoft | FR | **all thresholds** | calls, awards (`titulaire`), corrections, cancellations | none |
| `de-oeffentlichevergabe` — Bekanntmachungsservice daily OCDS export | DE | **all thresholds** | every eForms notice of the day | none |
| `gb-fts` — Find a Tender (OCDS) | GB | above threshold | calls, awards, planning | none |
| `gb-contracts-finder` — Contracts Finder (OCDS) | GB (England) | below threshold | calls, awards | none |
| `ca-canadabuys` — open tender notices CSV | CA | all (federal) | open calls | none |
| `us-sam` — SAM.gov opportunities | US | all (federal) | calls, awards, pre-solicitations | **free key**: `ULTRAPROSPECT_SAM_API_KEY` |
| `us-usaspending` — USAspending awards | US | all (federal) | awards only | none |
| `au-austender` — AusTender (OCDS) | AU | all (Commonwealth) | **contract notices only** | none |
| `br-pncp` — PNCP | BR | all | open calls, contracts | none |
| `ua-prozorro` — Prozorro public API | UA | all | calls, awards | none |
| `co-secop` — SECOP II on datos.gov.co | CO | all | processes, awards | none |
| `eu-ted` — TED API v3 | EU-27 + EEA + candidates | **above threshold** | calls, awards, prior information, modifications | none |
| `ww-worldbank` — World Bank procurement notices | worldwide | one funder's projects | calls, awards, general notices | none |
| `web` — the web lane | anywhere | what the search reached | calls, corroborated on the page | none |

Coverage is DECLARED, like a register's `mode`, and the run reports it per lane:

- **all** — the national portal: every threshold the law publishes.
- **above-threshold** — only contracts above the EU (or GPA) thresholds. A
  country served only by TED is listed in `manifest.gaps` with this coverage,
  and the report says that its national market below the thresholds is absent.
- **below-threshold** — Contracts Finder; with Find a Tender the UK is whole.
- **funded** — the World Bank: notices of projects it finances, never a census.
- **web** — corroborated pages; coverage is what the search reached.

A country no API serves (`coverage: none` in `gaps`) is reachable only by the
web lane. `WEB_MARKETS` in `src/tenders/web.ts` gives, per market, the search
language, its procurement vocabulary, its deadline labels and its portals (as
search hints — nothing is trusted because of its host).

## Measured, not assumed

- **TED needs no key**, and an unknown field name is a 400 listing all 1 830
  supported fields — so a field is safe to discover by asking for it.
  `classification-cpv IN (72000000)` is **hierarchical**: it returns 72250000
  and 72310000. `FT~(…)` is full-text across language versions. Award notices
  carry the winners' own identifiers ("609801535", "938 703 626 00011" — SIREN
  and SIRET) and `duration-period-value-lot` / `-unit-lot`.
- **TED's `/detail/` page renders in the browser** and serves only its menu to a
  fetch. `tender` reads the notice PDF in the buyer's language instead
  (`links.pdf.<LANG>`), which `fetchPage` extracts as text.
- **TED's `procedure-identifier` is the eForms ContractFolderID** — the same
  UUID as BOAMP's `contractfolderid` and the German `tender.id`. That is the
  exact key `tenders` de-duplicates on. Publication numbers never join:
  TED's "722908-2026" and Find a Tender's "103248-2026" look alike.
- **TED serves document URLs HTML-escaped** (`&amp;type=DCE`). Decoded on read.
- **BOAMP has no CPV column.** The CPV is inside `donnees` (the eForms notice as
  JSON), and only the European (`famille: JOUE`) notices carry one; most national
  notices (FNS, MAPA) carry no eForms at all. So keywords are sent upstream
  (`search(objet, …)`), and a CPV-only filter cannot judge a national notice —
  it is dropped, not waved through. Measured: a 7-day CPV-only pass read 300 of
  1 480 calls to keep 5.
- **Opendatasoft refuses `offset + limit > 10000`** with a 400. A wider query is
  reported truncated.
- **The German daily export publishes NO `tenderPeriod`** — no submission
  deadline. A German national notice is "status unknown" unless its TED copy
  (merged by procedure id) or its own page gives one. Today's export does not
  exist yet (HTTP 400); the lane stops at yesterday. ~1 000 notices a day,
  1.8 MB zipped; a query downloads at most 31 days.
- **AusTender's API exposes contract notices only**: every release on
  2026-10-01 carried `tag: ["contract"]`. Ask `awards`, never open calls.
- **SAM.gov answers 404, not 401, without a key.**
- **USAspending's `time_period` filters on ACTION date**: an award started in
  2014 and modified in 2026 comes back for a 2026 window. Only awards that
  STARTED in the window are kept.
- **The keyless search engines are often blocked** (DuckDuckGo anti-bot 202,
  Mojeek 403). `--engine-search` says "blocked, not empty". The agent's own web
  search is the real web lane.
- **A buyer platform links its own help files.** marches-publics.info's DCE page
  links `depot-pli.pdf` — a platform guide — above a login form ("POUR RETIRER
  UN DCE, VOUS DEVEZ VOUS IDENTIFIER"). `tender` keeps a document only when its
  text names the notice, the buyer, or enough of the title, and records the wall
  as `documentsAccess: "registration"`.

## The profile

`profile.json` is the bidder's evidence, citable like a page:

| Cite | Backed by |
|---|---|
| `[R1]`, `[R2]` … | `references[]` — past contracts: client, year, scope, value |
| `[C1]` … | `certifications[]` — name, issuer, validity |
| `[profile.offer]`, `[profile.staff]`, `[profile.turnover]`, `[profile.capacity]` … | any other field |

`tenders --template` prints a blank one. `keywords` is per language and is
the user's own vocabulary — the engine ships none and translates nothing.

## Verdicts

```json
[
  {"id": "eu-ted:746837-2026", "decision": "go", "fit": "strong", "why": "CATALA development is the core offer [P2] [profile.offer]", "blockers": [], "cites": ["P2"]},
  {"id": "fr-boamp:26-105228", "decision": "no-go", "fit": "no", "why": "training services, outside the offer [P1]"},
  {"pair": ["fr-boamp:26-1", "web:3f2a…"], "same": true, "why": "same buyer, object and deadline"}
]
```

`decision` is `go`, `maybe` or `no-go`; `fit` is `strong`, `possible`, `weak` or
`no`. A malformed verdict, an unknown id, or a `go` on an expired call makes
`tenders --apply` exit 1 and names it.

## Gate rules on a tenders run

| Rule | Fails when |
|---|---|
| `citation-unresolved` / `citation-foreign` | a `[P#]` no page has, or a page of another notice |
| `reference-unknown` | a `[R#]`, `[C#]` or `[profile.x]` the profile does not hold |
| `claim-uncited` | a factual paragraph with no `[P#]`, no profile id and no `[M]` |
| `bid-claim-unsourced` | a first-person claim with a number, a certification or a reference, and no profile id |
| `deadline-mismatch` | a deadline line whose date differs from the notice's, or an uncited one when the notice has none |
| `deadline-passed` | a `go` on a call whose deadline has passed |
| `award-forecast-unlabelled` | a re-tender / renewal date without "estimated" on the same line |
| `bid-orphan`, `page-missing` | a `bids/` directory with no notice; a stored page deleted |

Warnings: `run-truncated`, `coverage-gap` (per country), `documents-not-read`,
`compliance-missing`, `no-bids`.

## Awards

`awards` keys suppliers on their identifier first (a French SIRET is folded to
its SIREN, so one company with several sites is one winner) and never merges on
a fuzzy name: name-only suppliers that look like an identified one are listed
under "Names to confirm". Wins count distinct notices — a framework of twelve
lots is one win. A re-tender window is the award date plus the published
duration, minus 12 to 6 months, labelled "estimated from the notice's duration";
a row without a published duration gets no window. The top 15 identified
winners are confirmed with `verifyId` against their country's register
connectors; skip it with `--no-registry`.

## Administrative checklists

`src/tenders/checklists.ts` — France (DC1/DC2 or DUME, URSSAF, Kbis…), Germany
(EEE, PQ…), the UK (Procurement Act 2023, Central Digital Platform, PSQ), the US
(SAM/UEI, FAR), Canada, Australia, Brazil, and the ESPD for any EU member state.
Each names its official source. A reminder only: the notice's own list governs,
and a jurisdiction with no entry gets none borrowed from another.
