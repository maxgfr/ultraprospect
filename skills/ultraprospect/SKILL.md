---
name: ultraprospect
description: "Build a sourced prospect list for every company in a place, street, or radius. Use for territory-wide company discovery, register confirmation, website resolution, qualification, and citation-aware export; not for one-company lookups."
license: MIT
metadata:
  version: 3.9.0
---

# ultraprospect — a territory, turned into prospects you can cite

Like its `ultra*` siblings this is a **division of labour**. The engine decides
the mechanics: geocode the place, sweep what can be swept, tile around the
upstream caps, fuse what is certainly the same company, confirm the rest against
whatever authority the country has, account for what it could not reach. You decide the judgment: whether a near-miss pair is one business, what a
company actually does, which of them is worth a call.

The engine is built to be boring and honest about its edges. Nothing it produces
is a guess dressed as a fact, and every count it reports is one it measured.

> **The core rules:**
>
> 1. **Reason from the run, not from memory.** You know nothing about a town's
>    economy that is not in `places.json`. If it is not in the run, fetch it or
>    say you did not.
> 2. **A truncated run is a truncated run, and a confirmed one is not a sweep.**
>    When `manifest.truncated` is true, say so in the first sentence of whatever
>    you write, and name the lane. Read the register lane's `mode`, which the
>    Coverage table prints as its own column, and which France, the United
>    Kingdom and Estonia can answer `"sweep"` to — each by a DIFFERENT shape,
>    named in the lane's `reason`. When it says `"confirm"` say so: the
>    list is what OpenStreetMap holds for that territory, checked against the
>    register, not what the register holds. A company nobody has mapped is not in
>    it. And the UK's sweep is by POST TOWN, not by the bounding box the OSM lane
>    used — the lane's `reason` says so, and repeating that is the difference
>    between an enumeration and a claim about a slightly different territory.
>    Presenting any of these as a whole territory is the one failure nobody
>    downstream can detect.
>
> 2b. **A dated record is a fact about its date.** A record carrying `asOf` came
>    out of a bulk snapshot, not from asking the register just now. Germany's
>    export stopped in 2019, so a German register identity is who filed under that
>    number THEN. Write it that way — "registered at … as of 2018-07" — and never
>    let it found a present-tense claim. `check` enforces this; do not make it
>    have to.
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
| Get a keyless register for the UK, Germany or Estonia, once | `ingest --country gb` · `de` · `ee` |
| List every company in a town, street or radius | `scan --where "<place>"` |
| Same, narrowed to ONE KIND OF BUSINESS, both lanes | `scan --where "<place>" --category amenity=cafe,naf=56.30Z` |
| Same, narrowed to an industry or a company size | `scan --where "<place>" --section J,M --min-employees 10` |
| Answer the pairs the matcher would not decide | `match --run <dir> --apply verdicts.json` |
| Find each company's website (the host's native web search) | `resolve --run <dir> --queries`, then `--web-results` |
| Read those websites — what they do, who they hire | `enrich --run <dir> --tier 1`, then `--tier 2 --limit 20` |
| Attach a register identity outside France's sweep | `confirm --run <dir>` |
| Rank what you found | `score --run <dir>` |
| Write up one company from its evidence | `dossier --run <dir> --id <id>` |
| Prove the write-up is grounded before anyone reads it | `check --run <dir>` |
| Hand it over: CSV, report, one self-contained page | `render --run <dir>` |
| See what moved since last month's sweep | `watch --run <new> --since <old>` |
| Spread the judgement across subagents | `orchestrate --run <dir>` |
| Drive it all from another harness | `mcp` — serves where, ingest, scan, places, confirm, enrich, score, dossier, check, render, watch, doctor |
| Find out why a run came back thin | `doctor` |

## Cheat sheet

```bash
ultraprospect doctor --country de                             # are the upstreams this run needs up?
ultraprospect where "Vincennes" --country fr                  # resolve, or list the candidates and exit 2
ultraprospect scan --where "Vincennes" --country fr           # both lanes, fused
ultraprospect scan --lat 48.8566 --long 2.3522 --radius 500m  # a point and a radius
ultraprospect scan --where "Lyon" --section M --min-employees 20 --out ./runs
ultraprospect scan --where "Vincennes" --country fr --category amenity=cafe,naf=56.30Z   # ONE trade, BOTH lanes
ultraprospect scan --where "Kreuzberg, Berlin" --country de --category office=it          # where no register sweeps, OSM alone
ultraprospect resolve --run <dir> --queries --skip chain,unnamed,public,vacant            # spend no search on a bank branch
ultraprospect ingest --country gb                             # Companies House monthly snapshot, 470 MB, keyless
ultraprospect ingest --country de                             # the German register export, 260 MB, keyless
ultraprospect ingest --list                                   # what is cached, which vintage, how much disk
ultraprospect ingest --check                                  # has a register published something newer? exit 1 if so
ultraprospect scan --where "Hebden Bridge" --country gb        # after ingest: the UK register IS enumerated
ultraprospect scan --where "Berlin" --country de              # OSM sweeps the ground; the register comes later
ultraprospect confirm --run <dir>                             # Impressum -> HRB/USt-IdNr -> the authority confirms
ultraprospect scan --where "Berlin" --no-registry             # skip the register lane entirely
ultraprospect match --run <dir> --apply verdicts.json         # fold your adjudication back in
ultraprospect resolve --run <dir> --queries                   # the queries for YOU to search
ultraprospect resolve --run <dir> --web-results hits.json     # ingest your hits, fetch, corroborate
ultraprospect resolve --run <dir> --only <id,id,id>           # aim the lane: the ids you care about, not the first N
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

2. **Scan, with filters if the territory is dense.** This matters in France,
   where the register IS swept: a French commune holds tens of thousands of
   registered units, most of them dormant micro-entrepreneurs.
   `--min-employees`, `--section` and `--activity` are how a run stays useful; the
   register lane stops at `--max-results` and declares itself partial rather
   than spending twenty minutes.

2a. **`--category` is the only filter that aims BOTH lanes. Reach for it first.**

   The older filters each reach one lane and only one: `--osm-groups` narrows
   OpenStreetMap, `--section` / `--activity` / `--min-employees` narrow the
   register. Neither knows the other exists, so "I want cafés" said with either
   of them alone half-narrows the run. Measured on a Saint-Mandé sweep:
   `--section I` gave 154 register rows and left the OSM lane returning all 295
   places in town, of which 5 were cafés — one intent, two territories, and
   nothing in the output says so.

   `--category` takes ONE vocabulary aimed at both, and it is the vocabulary
   `places.json` already prints back at you:

   | You type | Lane | Means |
   |---|---|---|
   | `amenity=cafe` | OSM | that exact tag |
   | `shop` or `shop=*` | OSM | the whole key |
   | `naf=56.30Z`, `sic-uk=56302`, `pkd=…` | register | an activity code, in the register's own scheme |
   | `nace=I` | register | a section letter |

   So the round trip holds: whatever `category` a row carries, you can paste it
   straight back into `--category` on the next run. The scheme prefixes come off
   the connectors themselves, not a hardcoded list.

   **It refuses rather than half-narrow.** Name only OSM tags where a register
   CAN be swept and the run stops, because the register lane would enumerate the
   whole territory beside your five cafés. Answer it by naming the other lane
   too, or by saying the asymmetry is deliberate with `--category-lane osm`.
   Where no register can be enumerated at all — Germany, Spain, most of the
   world — there is no second lane to aim and an OSM-only category just runs.

   Two things it will not let you do, both of which used to return a confident
   nothing: mixing a section with an activity code outside it (`nace=I,naf=10.71C`
   — the register ANDs them, so the answer is zero rows), and excusing a lane
   that was not going to run anyway.

   Measured, same town: `--category amenity=cafe,amenity=restaurant,shop=bakery,
   naf=56.10A,naf=56.30Z,naf=10.71C` returns 48 OSM + 65 register = 89 places
   with **24 matched across both lanes** — against 422 places and 27 matches
   unfiltered. Nearly all the matches, a fifth of the noise.

2b. **Ingest first where a register publishes a file instead of an API.** The
   United Kingdom and Germany both do, and both exports are keyless.
   `ingest --country gb` fetches Companies House's monthly snapshot (470 MB) and
   turns the UK into a territory that can be ENUMERATED; `ingest --country de`
   fetches the German register export (260 MB) and gives `confirm` a source that
   names the holder of an HRB number. Each runs once and everything afterwards is
   a local read — `ingest --list` says what is cached and how much disk it took.
   Without the ingest, both connectors report themselves unavailable with that
   command in the message, and the run continues.

3. **Read the coverage before reading the data.** `manifest.lanes` says what
   each lane returned, whether it was capped, and — for the register lane —
   whether the territory was `"sweep"`-ed or `"confirm"`-ed. The report prints
   `mode` as its own column. `manifest.truncated` is the headline. Two registers
   can be enumerated keylessly and they are not enumerated the same way: France
   by bounding box through its API, the United Kingdom by POST TOWN out of the
   snapshot. Everywhere else the lane says in words that no register could be
   swept, and that is a property of the world's open data, not a failure of the
   run.

3b. **Where the register was not swept, run `confirm` after `enrich --tier 1`.**
   That order is not arbitrary: the strongest route reads the registration number
   off the legal notice tier 1 fetches — an `Impressum` in Germany, an `aviso
   legal` in Spain, both legally mandatory — and asks an authority whose it is.
   Without pages, `confirm` can only look companies up by name, which is a
   candidate rather than a fact. It refuses rather than doing the weak half
   silently.

   In Germany this is where the two sources divide the work, and saying which
   answered matters: VIES confirms a USt-IdNr is live TODAY and returns `"---"`
   for the holder, while `de-offeneregister` names who filed under an HRB number
   in 2017-2019 and stamps `asOf` on it. Neither alone is a current identity, and
   the pair is worth more than either. A German register number without its
   Amtsgericht is ambiguous by construction — the same number exists at several
   courts — so the connector refuses a bare number that matches more than one.

4. **Adjudicate `MATCH.todo.json`.** Each pair carries the OSM name, the register
   name that *actually scored* (`matchedName` — often an enseigne, not the legal
   name), the distance in metres and the component scores. Answer with a JSON
   array of `{osmId, registryId, connectorId, merge, why}` and fold it back with
   `match --apply`.
   Judge on evidence: same trade name, same street number, a brand the register
   files under an enseigne. When you cannot tell, say `merge: false` — two rows
   are recoverable, one wrong merge is not.

5. **Find the websites — this is your job, and the run rests on it.** Four in
   five places arrive without one, and everything downstream grows from that
   URL. `resolve` will **refuse to run** without search results rather than
   quietly check the handful OSM already tagged: on a real Vincennes sweep that
   silence produced 11 corroborated sites out of 1164, which reads as a town
   with no web presence instead of as a search nobody ran.

   **The keyless engines are blocked, so this loop is not optional.** Measured
   live: DuckDuckGo answers an anti-bot challenge with HTTP 202, DuckDuckGo Lite
   the same, Mojeek serves a challenge with a 200 and then a 403. All four, one
   run. `--engine-search` is a probe, not a plan — when it says **blocked**,
   nothing was searched, which is NOT the same as nothing being there.

   The loop, mechanically:

   ```bash
   # 1. size it, and spend nothing on rows that cannot become a prospect
   ultraprospect resolve --run <dir> --queries --skip chain,unnamed,public,vacant

   # 2. run EVERY printed query through your own WebSearch, one at a time

   # 3. pool every hit into ONE array — duplicates, directories, noise and all
   cat > hits.json <<'JSON'
   [
     {"placeId": "osm:n248494308", "url": "https://…", "title": "…", "snippet": "…"},
     {"placeId": "osm:n248494308", "url": "https://…", "title": "…", "snippet": "…"},
     {"placeId": "osm:n1585168700", "url": "https://…", "title": "…", "snippet": "…"}
   ]
   JSON

   # 4. hand them back — the engine fetches each one and judges it
   ultraprospect resolve --run <dir> --web-results hits.json
   ```

   `placeId` is the id from `RESOLVE.todo.json`; several hits share one, and
   that is expected. **Do not filter** — you are finding candidates, not
   choosing. The engine fetches each one and keeps it only if the page carries
   the company's registration number, its street address or the distinctive part
   of its name; a domain that ranked first and corroborates nothing is recorded
   as `unverified`, never as the website.

   **Spend the searches on rows that could buy something.** `--skip` drops the
   ones that cannot, and every test reads a tag a mapper ASSERTED rather than
   guessing from a name: `chain` reads `brand`/`brand:wikidata`, `public` reads
   `operator:type`, `vacant` reads `shop=vacant` and `disused:*`, `unnamed` is a
   row whose name is literally its own tag. Measured on the Saint-Mandé sweep:
   76 of 420 rows skipped — 42 chain, 24 unnamed, 9 public, 6 vacant, five of them
   counted twice — which is 104 searches not run on BNP Paribas branches and
   primary schools. Nothing is
   deleted: the rows keep their place in `places.json`, and `RESOLVE.todo.json`
   gains a `skipped` array naming each id and the reasons that applied — so you
   can disagree with a call and re-run without it, rather than take the total on
   trust.

   Two registers cannot be aimed at all and the run says so rather than
   pretending: Estonia enumerates but its export carries no activity code, so a
   register term there is refused instead of accepted and dropped.

   **A Facebook page is a finding, not a gap.** For a local trader it is very
   often the ENTIRE web presence, so `resolve` records it in `contacts.socials`
   and marks the place `webPresence: "social-only"` — its own state, beside
   `own-site` and `none`, and a column in the CSV. Measured on two Saint-Mandé
   food businesses: both came back `social-only`, which is the true answer and
   the actionable one. `none` means we searched and found nothing; an EMPTY
   `web_presence` means nobody has searched yet, and the two must not be read
   as the same thing.

   **The queries themselves prefer evidence to hope.** Where a street is known,
   `<name> <number> <street> <town>` is spent before the legal-notice angle: a
   café is not obliged to publish mentions légales and mostly does not, while
   the door number is a fact its site, its listing and its social page all
   repeat. Where there is no street — most German OSM nodes — the Impressum
   angle is still the best one left, and still runs. `--queries-per-place`
   raises or lowers the budget; three is the default because you run each one
   by hand.

   **Aim the lane on a big territory.** It is sequential and fetches per place,
   so a two-thousand-place sweep is a long run. `--limit` takes a PREFIX of the
   file; `--only <ids>` takes the places you actually want, which is what you
   need when the ones worth searching for are scattered through the sweep — the
   IT companies in a city of offices, the manufacturers in a mixed high street.
   Read `category` (and `registry.activityCode`, where a register answered) out
   of `places.json` to pick them. `--only` narrows `--queries` too, so a fanned
   out worklist matches the fold that follows it.

   With many places, fan it out: `orchestrate --run <dir> --phase resolve`.

6. **Enrich in two tiers, and spend the second one deliberately.** Tier 1 reads
   the homepage and the legal notice on every corroborated site: four requests,
   and it answers whether the site is alive, what it says it does, whether the
   company runs a hiring pipeline, and whether its registration is published there.
   Tier 2 is the expensive one — a page per role (about, services, products,
   pricing, careers, team, contact, cases, news) plus the openings read
   straight out of the ATS API rather than out of a JavaScript shell. Run it on
   the ones you have a reason to care about, not on the whole town: a thousand
   places at eight pages each is six thousand requests and several hours.

6b. **Bring your own vocabulary — the engine has none, on purpose.**

   `--terms` finds words VERBATIM in the pages tier 1 and 2 fetched, and
   `--roles` counts job titles matching them. Neither ships a default in any
   language, and that is the design rather than a gap. A word list frozen into a
   general tool is one person's curation wearing the costume of a measurement:
   it goes stale, it privileges whichever languages its author happened to
   speak, and for every market it misses it reports a confident absence.

   So translating a concept into a market's own words is YOUR job, and you have
   two things the engine does not: the languages, and the web.

   - **Translate the concept, not the German.** "Does this company buy outside
     work" is `portage salarial` and `auto-entrepreneur` in France, `ZZP` in the
     Netherlands, `autónomo` in Spain, `Freiberufler` and `Werkvertrag` in
     Germany, `libero professionista` in Italy. A literal translation of a
     German word finds nothing, because these are legal statuses, not synonyms.
   - **Check the phrasing against the live web before you scan.** Search how
     companies in that country actually word it on their careers pages, and take
     the words you SEE rather than the ones you expect. `resolve --engine-search`
     drives webindex's keyless search from inside this bundle, but prefer your
     own WebSearch: the keyless engines block automated clients, and when they
     do the lane says so in words rather than reporting an empty web.
   - **Mind the inflection.** Matching tolerates up to three trailing letters,
     which carries German `-n`/`-ern`, French `-s` and Spanish `-os`. Languages
     that inflect by REPLACING the ending — Polish, Czech — need a stem:
     `samozatrudnieni`, not `samozatrudnienie`.
   - **Refuse a term that means two things.** `B2B` means contractor in a Polish
     job ad and business-to-business in every English one. A term with two
     readings produces hits nobody can act on, and they will look measured.

     The trap is worst where the two readings live on the SAME page. Measured on
     a Hamburg run: of three companies whose careers page matched this lexicon,
     two carried `Freelancer` heading a real freelancer intake — "Wie deine
     Zusammenarbeit mit uns abläuft", "Freelancer? Bitte hier entlang!" — and the
     third matched `selbstständig` three times in "Freiraum für selbstständiges
     und eigenverantwortliches Arbeiten", which describes an EMPLOYEE working
     autonomously. Same page role, same lexicon, opposite meanings. German
     `selbstständig`/`selbständig`, French `autonome` and English `independent`
     all read both ways in a job ad; the words that only mean the legal status —
     `Freiberufler`, `freiberuflich`, `Werkvertrag`, `Subunternehmer`,
     `portage salarial`, `ZZP` — are the ones worth counting.

   **`--terms-on` defaults to the careers page, and widening it is a decision.**
   Measured on a real run before that default existed: 48 hits from home and
   legal pages, and every sampled one was wrong — `externe Dienstleister` naming
   data processors in a privacy policy, `Freiberufler` naming the CLIENTS a law
   firm advises, `Freelancer` on a one-person studio's homepage describing its
   owner. The words were right and the page was wrong, which is the worst shape
   of wrong here because it reads as evidence.

   Whatever you pass is recorded in the signals beside the hits, so a count
   always says what it counted, and `check` re-reads every hit against the page
   it cites.

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
   come from. Contacts declared in OSM carry the exact feature as `osm:<id>`;
   the gate re-reads that feature from the run's `osm.json` and looks only at
   its contact tags. That last rule is the one that matters: an address
   assembled from a naming convention is plausible, unfalsifiable at a glance,
   and will be emailed. The gate makes it impossible rather than discouraged.

10. **Render, and hand over all four — they are not the same deliverable.**
    `render` writes one run in four shapes, and which one you put in front of
    someone decides whether they can act on it:

    | File | What it is for | Hand it to |
    |---|---|---|
    | `index.html` | **Looking.** Self-contained, makes NO network request, opens from a file:// path with nothing installed. Sort, filter and facet in place to find the twenty rows that matter out of eight hundred — then open any row: the verdict verbatim, the score broken into the terms that produced it, every contact with the page id it was read from, the open roles, the register identity and its `sourceUrl`, the site signals. With JavaScript off, every panel is open. | anyone who has to SEE the territory |
    | `REPORT.md` | **Reading and sharing.** Coverage with each lane's `mode`, which connector answered and what attached each record, what the run was narrowed to, the counts, the score distribution, who is hiring, every `fit` verdict verbatim, the ranked table, and run notes deduplicated with their counts. Pastes into an issue, a PR, a wiki, a mail. | anyone who has to judge whether the run is sound |
    | `PROSPECTS.csv` | **Working.** Flat and CRM-shaped: `score` and `fit` in separate columns so the measured number survives your judgement, each contact's source page beside it, `registry_as_of` on anything from a snapshot, and `role_filter` / `term_lexicon` beside their counts so a number says what it counted. | a CRM, a spreadsheet, a mail-merge |
    | `prospects.json` | **Piping.** The same rows, unflattened, for whatever comes next. | another program |

    Do not hand over one and describe the others. The CSV is where someone will
    act, the HTML is where they will look first, and the report is the only one
    that carries the coverage — a CSV read without it is a list with no idea how
    much of the territory it covers.

    If the run is truncated, both the report and the page lead with that —
    repeat it, do not paraphrase it away. If `PRIVACY.md` was written, the run
    holds named individuals and that file says what follows from it.

11. **Write from `places.json`.** Every field carries where it came from. A place
   with `sources: ["osm","sirene"]` has both records attached; a place with one
   source has one, and the other half is not "missing data" you may fill in.
   OSM-declared emails, phones and social profiles are carried into `contacts`
   with an `osm:<id>` source, so they remain distinct from contacts observed on
   a fetched page and can be re-read from `osm.json` by `check`.
   `website.confidence` is `corroborated`, `unverified` or `declared` (a mapper
   typed it into OSM and nobody has checked) — say which when it matters.

## When the run looks wrong

| Symptom | Cause |
|---|---|
| `where` exits 2 with a list | Working as designed. Several distinct places match; choose one. |
| Very few OSM places | Overpass mirrors were busy. `doctor` shows which answered; re-run. |
| Contacts are empty after `scan` although OSM has phone tags | They are now carried as declared contacts with an `osm:<id>` source. Re-run the scan with the current build. |
| `truncated: true` on the register lane | A French territory exceeding the API's 10 000-result ceiling even after the NACE split, or `--max-results` was reached. Narrow the filters. |
| Register lane `mode: "confirm"`, not `"sweep"` | Expected everywhere but France and the United Kingdom. OSM covered the ground; run `confirm` to attach register identities company by company. |
| The UK register lane returned nothing | No snapshot in the cache. Run `ingest --country gb` once, then re-scan. The lane's reason says so verbatim. |
| A UK sweep missed a company you can see on the street | Its registered office is in another post town — very often its accountant's. The sweep enumerates by post town, and the lane's reason says a post town is not a bounding box. |
| A German record carries `asOf: 2018-…` | Working as designed. The German export stopped in 2019 and each record says when it was retrieved. Write it as a fact about that date, never as today's. |
| `de-offeneregister` refused a register number | The bare number exists at more than one Amtsgericht. Supply the court from the Impressum, or leave it unattached — a number is not an identity without its court. |
| `confirm` found identifiers but named no holders | Expected in Germany and Spain: VIES confirms a VAT number is live and does not disclose who holds it. The identifiers are on the record, sourced and re-readable. |
| `confirm` found nothing at all in the US | Expected. There is no US company register and no published company number; identity there rests on address and name. |
| A merged place looks like two companies | Adjudication was skipped or answered too generously. Check `matchConfidence` and the raw lanes in `osm.json` / `registry.json`. |
| Thousands of dormant one-person companies | Add `--min-employees`; ceased companies are already excluded unless `--include-ceased`. |
| The run is full of schools, bank branches and EV chargers | `--osm-groups amenity` is a whole catalogue group, not a trade. Aim it with `--category amenity=cafe,…`, and drop what cannot buy with `resolve --skip chain,public`. |
| `scan` refused: "left the … lane sweeping unfiltered" | Working as designed. A `--category` list that narrows one lane and not the other produces a run whose halves cover different territories. Name a term for the other lane, or `--category-lane <the one you meant>`. |
| `scan` refused: activity codes "fall outside the sections asked for" | The register ANDs section and activity code, so `nace=I,naf=10.71C` would return zero rows and read as an empty trade. Ask for one or the other. |
| `--max-results` truncated before the sector I wanted | The register splits by NACE section IN ORDER, so a budget spent early never reaches the later letters — and the lane now names them: "reached after NACE sections A-F; G-U were never asked for". That is a prefix, not a sample. Name the trade with `--category naf=…` instead of paying for sections you did not want. |
| A company shows `web_presence: social-only` | Not a gap. We searched, found no site of its own, and found a social profile that is theirs. For a local trader that is usually the whole web presence. |
| `web_presence` is empty | `resolve` has not run for that row. Different from `none`, which is a measured absence — do not report the two the same way. |
| `resolve` exits 2 saying no results were supplied | Working as designed. Run `--queries`, do the searching, pass `--web-results`. |
| `--engine-search` says the keyless fallback was **blocked** | The engines refused the request — a 403, or an anti-bot challenge served with a 200. Nothing was searched, which is NOT the same as nothing being there. Do your own WebSearch and pass `--web-results`; never report the run as a territory with no web presence. |
| `--engine-search` corroborated almost nothing | Expected, and the reason `resolve` refuses to run without your hits. Measured on a Saint-Mandé sweep: 0 sites out of 12 through the keyless fallback, 9 out of 12 from the same queries run through the agent's own WebSearch. |
| A company's own domain shows as `unverified` | The page did not carry its name, address or registration number. Often a JavaScript-only site — the evidence string says which. It is a candidate, not a confirmed site. |
| `enrich` says "no place has a corroborated website" | `resolve` has not run, or corroborated nothing. Enrichment only ever reads sites we proved belong to the company. |
| A company with a careers page shows `isHiring` unset | Deliberate. A board was detected but its openings could not be read, and "not hiring" would be a different claim. |
| `check` says a contact is not on its page | Believe it. Either the value was constructed, or the page changed since it was read. Both mean it must not ship. |
| `check` flags a line you consider obvious | It is a factual claim with no source. Cite the page, or mark it `[M]` and own it. |

## Do not

- Never present a run with `truncated: true` as a complete list of a territory.
- Never merge a `MATCH.todo.json` pair you cannot justify from its evidence.
- Never write a contact detail that is not verbatim in a fetched page or an
  open-data record, and never derive one from a naming pattern.
- Never describe a `confirm`-mode run as if the register had been swept, and
  never describe the absence of a sweepable register as a failure.
- Never present a UK sweep as covering a bounding box. It enumerates a POST TOWN,
  which is a real enumeration and a different shape; the lane says so and so
  should you.
- Never write a record carrying `asOf` in the present tense. Germany's register
  data stops in 2019, and "is registered at" where the evidence says "was
  registered at, as of 2018-07" is the same class of claim as a confirmed
  territory presented as a swept one.
- Never present an identifier an authority declined to attribute as an identity.
- Never strip the attributions in `manifest.licences` from a deliverable, and
  never add one for a connector that did not answer.
- Never re-run a sweep to "check" a number the manifest already reports — the
  upstreams move, and a second run answers a different question.
- Never treat a search result as a company's website. Rank is not evidence of
  ownership; only the fetched page corroborating itself is.
- Never present a run whose `check` exits non-zero. There is no "with caveats".
- Never turn the `--icp` text into a number. The engine refuses to; so should you.
- Never report a `--skip`ped row as absent from the territory. It was not
  searched for, which is a decision about budget, not a finding about the world.
- Never present a half-narrowed run as one trade: `--section` and `--osm-groups`
  each reach one lane, and the run's two halves then describe different
  territories. `--category` is the one that aims both, and it refuses rather
  than let that happen silently.
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

**Each phase names the model it wants, and it is not the same one.** The fan-out
decides how many agents a phase runs; this decides which head, and the question
that settles it is what still catches the mistake afterwards:

| Phase | Model | Because |
|---|---|---|
| `resolve` | **haiku** | Search plus bookkeeping. A mis-tagged hit cannot reach the deliverable: the engine fetches every URL and keeps it only if the page corroborates THAT place. This is also the phase that fans out widest, so it is where the cheap head pays. |
| `match` | **sonnet** | Nothing downstream re-checks a merge. A wrong `merge: true` ships one plausible company holding somebody else's registration number, and no gate in the pipeline can see it. |
| `dossier` | **sonnet** | `check` catches a citation that does not resolve and a contact never observed. It cannot catch a packet that was skimmed, which is the whole of what the phase is paid for. |

The emitted `*.workflow.mjs` already carries these, and each
`agents/<role>.md` repeats its own — only one of the three harnesses above reads
the workflow file, and a rule that lives only there is absent from the other two.
Dispatching subagents by hand, or working down `RUNBOOK.md`, use the same
tiering. It is a property of the phase, not of the country: it holds identically
for a French sweep and a German confirm.

Subagents never write; the folds stay with you, the orchestrator. Re-run
`orchestrate` whenever a worklist changes.

## References

| Open it when | File |
|---|---|
| You need an upstream's exact parameters, limits or failure modes | [references/data-sources.md](references/data-sources.md) |
| You are ingesting a bulk export, or wondering what `asOf` means | [references/data-sources.md](references/data-sources.md) |
| You are adjudicating pairs and want the scoring model | [references/matching.md](references/matching.md) |
| You are enriching, or wondering why hiring is unknown | [references/enrichment-playbook.md](references/enrichment-playbook.md) |
| You are ranking, writing a dossier, or reading a gate failure | [references/scoring-and-citations.md](references/scoring-and-citations.md) |
| A run behaved oddly, or you need exit codes and env vars | [references/operations.md](references/operations.md) |
| The deliverable will be shared, stored, or contains people | [references/privacy-and-licensing.md](references/privacy-and-licensing.md) |
