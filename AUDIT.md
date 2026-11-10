# Audit — ultraprospect 3.17.0

Audited on 2026-11-10 against commit `5e189b4`. Every source file under `src/` was read in full
(the vendored engine in `src/vendor/` is pinned by checksum and was left out). A live end-to-end
run on Hamburg was used as a second instrument, and found four defects the read had missed.

## Summary

- **Healthy baseline.** Typecheck, lint, 828 tests, the reproducible-bundle check, 33 offline evals
  and the offline demo all passed before any change. Nothing was failing.
- **The defects were where the product's promise is.** The most serious ones let a partial result
  pass as a complete one (an Overpass timeout, a failed register page, a half-written ingest) or
  let named people through `--no-people`. None raised an error; each produced a plausible output.
- **36 commits before this report**: 30 bug fixes, 3 measured optimisations, 3 cleanups. 916 tests now (88 added),
  coverage 65.4 % of statements, up from 63.6 %; the thresholds were not touched.
- **The live run changed the priorities.** On 62 Hamburg companies the original bundle filed five
  directories as company websites and counted "Kiste" and "Kiel" as mentions of AI. Both are fixed.
- **Left open:** eleven advisories in development dependencies, the SSRF surface of fetched URLs,
  and ten questions of intent listed at the end, which were not guessed at.

## Bugs fixed

Each fix has a test that fails without it, unless the last column says otherwise.

### Partial results presented as complete

| File | Issue | Fix | Test |
|---|---|---|---|
| `src/overpass.ts` | Overpass answers a timeout or memory failure with HTTP 200, the elements gathered so far and a `remark`. Only `elements` was read, so half a city counted as a whole partition. | The remark is treated as a too-big failure: the area is split, or the lane is declared incomplete. | `tests/overpass-remark.test.ts` |
| `src/registry/fr-sirene.ts` | A results page failing after the first stopped the walk and returned as finished: a 500 on page 7 of 40 gave six pages and no flag. | The error travels with the records read, and the lane is marked truncated. | `tests/fr-sirene-split.test.ts` |
| `src/registry/fr-sirene.ts` | Splitting a section at the 10 000 cap replaced the caller's activity codes with each division's full list, so `--activity 68.20B` returned all of division 68. | Divisions are narrowed to the codes asked for; a single code still at the cap is declared truncated. | `tests/fr-sirene-split.test.ts` |
| `src/snapshot.ts` | A re-ingest deleted the shards and kept the old `meta.json`. Any failure afterwards left last month's claim over half-written shards, swept as the whole register. Write-stream errors crashed or hung. | `meta.json` is removed first and written back last through a rename; stream errors are rethrown. | `tests/ingest-integrity.test.ts` |
| `src/snapshot.ts`, `gb-companies-house.ts`, `ee-ariregister.ts` | `ingest --limit` produced an index indistinguishable from a full one. | The limit is recorded; a sweep over that sample is truncated and says why. | `tests/ingest-integrity.test.ts` |
| `src/scan.ts` | Replaying a fixture of a country with no sweepable register wrote the lane as `mode: "sweep"` with zero rows. Found on the Hamburg run. | The replay says what a live run says: no register can be swept there. | `tests/scan.test.ts` |
| `src/snapshot.ts` | Register exports were decoded chunk by chunk, so a character split across a chunk became two U+FFFD: one corrupted Estonian or German name every few hundred rows. | One decoder across chunks; a quote ending a chunk is held until the next. | `tests/snapshot.test.ts` |

### Privacy and security

| File | Issue | Fix | Test |
|---|---|---|---|
| `src/scan.ts` | `scan --no-people` stripped officers from `places.json` but wrote them to `registry.json` and to a `--record` fixture, while reporting that the run held organisation data only. | Officers are stripped from the records themselves. | `tests/scan.test.ts` |
| `src/render.ts` | `render --no-people` cleared one CSV column; officers and people stayed in `prospects.json`, `REPORT.md` and `index.html`. | Every deliverable is built from the same stripped rows. | `tests/render.test.ts` |
| `src/util.ts` | CSV formula injection: an OSM name such as `=HYPERLINK(...)` was written as-is to `PROSPECTS.csv` and the tenders CSV. | Cells a spreadsheet would execute get a leading apostrophe. | `tests/util.test.ts` |
| `src/html.ts` | `link()` wrote any scheme into `href`; job URLs come straight from applicant-tracking APIs. | Only web, mail and phone links are clickable. | `tests/render.test.ts` |
| `src/zip.ts`, `src/tenders/notice.ts` | The reader allocated whatever the central directory claimed (up to 4 GB); tender document archives were inflated into memory with no ceiling; a read error hung the inflater. | The directory must lie inside the file; a member is capped at 128 MB, declared and actual; read errors are forwarded. | `tests/zip.test.ts` |
| `src/signals.ts` | The email pattern was quadratic on a long token with no `@`: one 200 KB token stalled enrichment for minutes. | Anchored on a token start and bounded at 64 characters. | `tests/signals.test.ts` |

### Wrong data attached to a company

| File | Issue | Fix | Test |
|---|---|---|---|
| `src/resolve.ts` | Candidates were tried in search-rank order and the first to corroborate won. Directories always corroborate. On Hamburg, 5 of 7 searched companies got a directory as their website, and one inherited the directory's legal representative. | Hosts spelling a distinctive token of the name are tried first; five measured directories join the German list. | `tests/resolve.test.ts` |
| `src/resolve.ts` | `host.includes("x.com")` filed rolex.com, dropbox.com and fedex.com as social profiles; `"ebay."` matched debay.fr. | A listed host matches itself and its subdomains. | `tests/resolve.test.ts` |
| `src/resolve.ts` | A name was corroborated when its tokens appeared anywhere in the page: "Arte" in "carte", "Mars" in "Marseille". | Tokens must be words of the page, or the name written as one word. | `tests/resolve.test.ts` |
| `src/enrich.ts` | Legal-page guessing settled on the first path without fetching it, so only `/mentions-legales` was ever tried. Depth alone chose among legal pages: 9 of 26 slots on Hamburg went to `/datenschutz`. | A notice outranks a privacy page, the run's language outranks a translation, and up to three guesses are fetched in the country's order. | `tests/enrich-legal.test.ts` |
| `src/people.ts` | Role labels matched as substrings, case-insensitively: "Director" was a CTO, "Coordinator" a COO. | A label has to stand as a word; German keeps left compounding for its own labels. | `tests/people.test.ts` |
| `src/signals.ts` | `--terms` tolerated three trailing letters on any term. Asked for `KI` and `AI`, the Hamburg run recorded Kiste, Kiel, Kiez, Kind, Kilo, kiosk, Air and ainsi. | The tolerated ending scales with the term; an acronym is matched in its own case. | `tests/signals.test.ts` |
| `src/match.ts` | `match --apply` could attach one record to two places, overwrite a place's identity, or delete an OSM place already fused. Adjudicated merges were labelled as scorer matches. | One record onto one unmatched place; the rest is refused and reported; labelled `agent-adjudicated`. | `tests/match.test.ts` |
| `src/confirm.ts` | The name route attached the best-scoring hit, including a dissolved company sharing the name. | Ceased hits are skipped on the name route. | `tests/confirm.test.ts` |
| `src/legal-notice.ts` | "El teléfono es 912 345 678" was extracted as the Spanish VAT number ES912345678. | A VAT prefix has to be in capitals. | `tests/legal-notice.test.ts` |
| `src/registry/gb-companies-house.ts` | A name made only of legal forms normalised to an empty string and matched the first five companies in town. | The substring test needs at least three characters. | `tests/snapshot.test.ts` |
| `src/registry/pl-krs.ts` | The section was the division's digits ("62") instead of the NACE letter. | Uses the shared NACE mapping. | `tests/connectors.test.ts` |

### Silent failures and wrong answers

| File | Issue | Fix | Test |
|---|---|---|---|
| `src/confirm.ts`, `src/legal-notice.ts` | A Greek VAT number carried its prefix `el` as its country and matched no connector, so VIES was never asked. | The identifier carries the ISO code `gr`. | `tests/confirm.test.ts`, `tests/legal-notice.test.ts` |
| `src/confirm.ts`, `src/run.ts` | A second confirm pass that attached nothing dropped the licences owed for earlier records (including the German export's CC-BY), and overwrote the confirmed count. | Licences also come from the records held; the count accumulates. | `tests/connectors.test.ts` |
| `src/csv.ts`, `src/score.ts`, `src/cli.ts`, `src/mcp/adapter.ts` | `--min-fit strng` kept every row, including those judged "no". A verdict with an undefined fit was stored, sorted as NaN, and `null` crashed the command. | Both are refused with the valid values. | `tests/render.test.ts`, `tests/score.test.ts` |
| `src/cli.ts`, `src/util.ts` | `--max-results 1e4` was read as 1; `--limit abc` became the default; `--pick 9` was clamped past the geocoder's refusal; coordinates off the planet were accepted. | Non-integers and invalid coordinates are usage errors. | `tests/cli-numeric-flags.test.ts` |
| `src/enrich.ts`, `src/signals.ts`, `src/pages.ts` | A malformed `mailto:` threw in `decodeURIComponent`; the catch-all then recorded a live site as unreachable. | Decoding falls back to the raw value; a read failure is reported as one. | `tests/signals.test.ts` |
| `src/watch.ts` | A place that gained a register record between runs was reported as one disappearance and one appearance. | Two runs are joined on any key a place shares. | `tests/render.test.ts` |
| `src/tenders/util.ts` | A deadline's day was compared with UTC's date: a US notice closed seven hours early, an Australian one stayed open eleven hours late. | A time with an offset is compared as an instant. | `tests/tenders.test.ts` |
| `src/tenders/verdicts.ts`, `awards.ts`, `commands.ts`, `profile.ts` | A pair `[x, x]` dropped notice x; award totals mixed currencies; `tenders-ranked.json` was unranked; a profile without a company crashed the bid packet. | Each refused, corrected or guarded. | `tests/tenders.test.ts` |
| `src/mcp/adapter.ts` | `scan` had no `pick` although its error asked for one, and dropped an invalid radius; `enrich` ran without the run's country and town; `watch` lacked the CLI's guards. | Aligned with the CLI. | `tests/mcp.test.ts` |
| `src/summary.ts` | A `--category` run was described as unfiltered; size and legal-form filters were never described. | Every narrowing filter is described. | `tests/summary.test.ts` |

## Optimisations

| Change | Before | After | How it was measured |
|---|---|---|---|
| `src/check.ts`: each page is normalised once per run instead of once per value citing it. | 824 ms | 183 ms | 150 places, 300 pages of 40 KB, 2 700 contacts; median of 5 runs of `runCheck`. |
| `src/snapshot.ts`: lines of other towns in a shard are skipped on their prefix instead of being parsed. | 327 ms | 159 ms | 61 MB shard of 200 000 lines where the town asked for holds 5 000; median of 5 lookups. |
| `src/confirm.ts`: one verification per identifier per run, and only authorities able to answer. | 26 VIES calls for 20 distinct numbers, plus one GLEIF search per VAT number | 20 VIES calls, no GLEIF search for a VAT number | Counted on the live Hamburg run; VIES is paced at one request a second, so about 6 s and 26 requests saved on 49 companies. |

The benchmark script was temporary and is not in the repository.

## Behaviour changes you will notice

- **CSV:** a text cell starting with `=`, `@`, or `+`/`-` followed by anything but digits and phone
  punctuation now starts with an apostrophe. Numbers, coordinates and phone numbers are unchanged.
- **Refusals instead of tolerance:** an unknown `--min-fit`, a non-integer numeric flag, coordinates
  outside valid ranges, an invalid fit in a verdict file, and an unparseable MCP `radius` now exit
  with a usage error. `--pick` above 5 is no longer clamped.
- **`--no-people`** now removes officers from `registry.json`, recorded fixtures, `prospects.json`,
  `REPORT.md` and `index.html`, not only from `places.json` and one CSV column.
- **`--terms`:** short terms match fewer strings. `KI` no longer matches `Kiste`; `Data` no longer
  matches `Daten`. SKILL.md documents the new rule.
- **Website resolution:** a domain carrying the company's name is fetched before higher-ranked hits.
- **Tier 1:** up to three legal-notice paths may be requested per site instead of one.
- **`match --apply`:** verdicts that would double-attach or overwrite are reported as unknown pairs.
- **Evidence label:** adjudicated merges read `sweep:agent-adjudicated` in the CSV.
- **MCP:** `ultraprospect_scan` gains `pick`; `ultraprospect_enrich` gains `roles`, `terms`, `termsOn`.

## Live run — Hamburg

The brief was "contact Hamburg companies interested in AI transformation". The run was real:
one Overpass sweep, web searches, company sites, VIES and GLEIF. Nothing was sent to anyone.

**What was run.** `scan --where Hamburg --country de --osm-groups office` returned 2 584 offices in
33 s, untruncated, 1 365 of them with a website declared in OSM. Germany has no sweepable register,
so the lane said `confirm`. From there the run was aimed at 62 offices across IT, consulting,
logistics, energy, media and professional services: website resolution (eight of them through web
search), tier 1 on every proven site, `confirm` against VIES and GLEIF, scoring, tier 2 on the
twenty best, fit verdicts, three dossiers, `check`, `render`.

**Before and after, same 62 companies.** The sweep was replayed offline from its own recorded
lanes for the second pass, so Overpass was asked once.

| | Bundle 3.17.0 | After the fixes |
|---|---|---|
| Sites filed as corroborated | 37 | 35 |
| …of which were directories, not the company | 5 | 0 |
| Legal pages read | 26, of which 9 privacy policies and 1 Spanish translation | 30, all legal notices |
| Named officers found at tier 1 | 22, one of them a directory's own representative | 29 |
| Term hits for `KI` / `AI` that were other words | Kiste, Kiel, Kiez, Kind, Kick, Kilo, kiosk, Air, ainsi, aider | none |
| Replayed register lane | `mode: sweep`, 0 rows | not swept, `confirm` is the route |

**Result.** `check` exits 0 with no error and 15 warnings, all for websites fetched but not
corroborated. 45 registration numbers were read off legal notices: 3 produced a register identity
and 42 stayed on the record without one, mostly VAT numbers whose holder VIES does not disclose
for Germany. 8 more companies were attached by name lookup (see "Found, not fixed", item 5). Sixteen companies were
judged against the brief and split as asked:

- *Buyers with a measured AI signal:* Amprion (a subsidiary founded to develop AI for the grid) and
  RTL Deutschland (a Chief Transformation & AI Officer on its management page) — strong; a tax
  practice positioned on digitalisation and an IT provider to accident insurers — possible.
- *AI players, as partners or competitors:* ClassiX Software (an AI chat product) and Metamorphio
  (a digital-transformation consultancy) — strong; CoreMedia, iC Consult and Seiten-Werk — possible.
- *Sector fits, no signal on the pages read:* three logistics and metering companies — weak.

**What it says about coverage.** 62 of 2 584 offices were read. The other 2 522 are in the run
with their OSM data only; "interested in AI" is a statement about pages that were fetched, and a
company with no hit is a company whose few pages did not say so.

**Further findings from this run**, all listed below: `confirm` without `--limit` starting 2 535
name lookups; near-namesakes attached by name; "Geschäftsführung:" missing from the German role
labels, so one company's four managing directors were not read; `counts.withWebsite` dropping
from 1 365 to 35 after `resolve`; `counts.dossiers` staying at 0 after three dossiers were saved.

## Found, not fixed

### Critical

None.

### Important

1. **Fetched URLs are not restricted to public hosts (SSRF).** `tenders/notice.ts`, `tenders/web.ts`
   and `resolve.ts` fetch URLs taken from pages, search hits and buyer-supplied fields. Nothing blocks
   `http://169.254.169.254/` or `http://localhost:…`, and the vendored engine has no default guard.
   It matters most under `ultraprospect mcp`. *Recommendation:* add a public-host check in the
   engine's fetch path (webindex), since `cachedFetchAndExtract` does not accept the `authorizeUrl`
   hook that `httpGet` does, then re-pin.
2. **Eleven advisories remain in development dependencies** (2 critical in `handlebars` under
   semantic-release, 2 high in `js-yaml` and `vite`). Patched versions exist inside the declared
   ranges but `pnpm update` would not select them here. They never reach the published bundle.
   *Recommendation:* add `pnpm.overrides` for `handlebars`, `js-yaml` and `vite`, or re-run the
   update once your registry policy admits those versions. `esbuild` needs a tsup release.
3. **`confirm` has no `--only`.** `resolve` and `enrich` can be aimed at a list of ids; `confirm`
   takes a prefix with `--limit`. On Hamburg, running it without a limit started 2 535 speculative
   name lookups against GLEIF before it was stopped. *Recommendation:* add `--only`, and consider
   making the speculative tail opt-in.
4. **Upstream outages are counted as "not found".** Most connectors return `undefined` on an HTTP
   error, so a VIES or GLEIF outage reads as companies with no register record. Only Companies
   House throws. *Recommendation:* throw on non-OK, non-404 responses in each `verifyId`.
5. **Name lookups attach near-namesakes.** On Hamburg, "AM GmbH" received "AM Holding GmbH" and
   "Transcargo GmbH" (TCO Transcargo) received "TRANSCARGO Internat. Speditions-GmbH", both labelled
   `name-lookup`. *Recommendation:* require a shared locality or postcode before attaching by name.
6. **`--bbox` in France sweeps a fixed 1 km disc** around the box centre whatever the box size
   (`fr-sirene.ts`), and nothing reports the mismatch. *Recommendation:* derive the radius from the
   half-diagonal, capped at the API's 50 km, and mark the lane truncated beyond it.
7. **BAN commune code ignores the chosen candidate.** `geocode.ts` looks up the raw query, so
   `--pick 2` can sweep the register of a different commune than the one picked.
8. **`--no-people` is not persisted.** A later `enrich` or `confirm` adds people back to a run
   scanned with it. See the open questions.
9. **Tenders:** `nn/nn/yyyy` deadlines are read day-first for US and Canadian markets; look-alike
   pairs are erased from `TENDERS.todo.json` once the web lane runs; a supplier's country is taken
   from the buyer; TED paging has no read budget when a post-filter drops most rows.

### Minor

- Website corroboration reads only the home page. In Germany the Impressum always carries the
  address, and short names ("VTG", "AM") can never corroborate on name tokens. 14 of 62 Hamburg
  sites stayed unverified for this reason.
- The corroboration refusal says "nor its SIREN" on runs outside France.
- "Partner" as a role label reads a partner company as a person ("Astor Gewerbeparks — Partner"),
  and "Geschäftsführung:" is not among the German labels, so a board listed under it is not read.
- `manifest.counts.withWebsite` counts declared sites after `scan` (1 365 on Hamburg) and only
  corroborated ones after `resolve` (35), so the number falls when work is done. `counts.dossiers`
  is not updated when a dossier is saved where the packet says to save it.
- A bundle file not named `ultraprospect.mjs` exits 0 without running anything.
- `match.ts`: the matching grid is narrower than the 150 m gate in longitude above 47.6° latitude;
  name variants are re-normalised for every candidate pair.
- `snapshot.ts`: a scan that stops at its limit leaves a file descriptor open; a download failing
  midway does not fall back to the next URL; two concurrent ingests are not locked against each other.
- `us-edgar.ts`: names containing `&` never match; tickers of one company are fetched twice.
- `no-brreg.ts`: a number longer than nine digits is truncated to nine and looked up.
- A variable-length VAT pattern can swallow the digits of a phone number that follows it.
- Markdown injection: names and verdict text are escaped in table cells only, not in headings.
- `mkdir` runs under `--stdout`; `match --apply` does not rewrite `MATCH.todo.json`.
- Duplicated helpers: the page-directory sanitiser (five copies), an accent-folding lambda (three),
  `EU_MEMBERS` beside `EU27`, `recordKey` re-implemented in `confirm.ts`.
- Connectors on unrelated hosts are queried one after another in `tenders/search.ts`.

### Larger changes, not attempted

- Major upgrades: vitest 5, semantic-release 25, `@types/node` 26, biome 2.6.
- A per-connector declaration of which identifier kinds exist in a country, so that Norway stops
  reporting "no site published a registration number" when no Norwegian extractor exists.

## Open questions

1. **`matchConfidence = 1` for a merge the agent adjudicated.** `types.ts` says the value is
   "never rounded up to certainty". Should an adjudicated merge carry the pair's score instead?
2. **`--min-score` and `--min-fit` filter only the CSV.** `prospects.json`, the report and the page
   keep every row. Intended, or should they apply to all deliverables?
3. **`check` exempts headings and fenced code from `claim-uncited`.** A dossier written as
   `### Revenue is €5M` passes. Intended?
4. **A German register number filed at another court is accepted** when it is the only hit, even if
   the Impressum names a different court. Tolerance for spelling, or should a contradiction refuse?
5. **Polish KRS status** is `active` whenever `stanPozycji` is present. Is that field a state code
   that also covers struck-off entries? It needs a live payload to decide.
6. **`attested`** counts identifiers where the authority named a different company. Rename, or narrow?
7. **Job de-duplication** drops postings with the same title and location, which undercounts three
   genuine openings for the same role. Intended?
8. **Should `--no-people` at scan time bind later stages?** That means persisting it in the manifest.
9. **Overpass network failures are treated as "too big"** and trigger splitting: an outage costs up
   to 85 tiles across 4 mirrors. The comment argues for it; a network-down case may deserve a stop.
10. **CSV apostrophe prefix.** It is the standard defence, and it alters the cell for a machine
    reader. If a CRM import consumes this file, would you rather have an opt-out flag?
