# Reading the websites

## Why there are two tiers

A small French town holds around a thousand mapped businesses, two hundred of
them with a website. Fetching eight pages each, at the per-host pacing that
keeps this tool welcome, is six thousand requests and several hours — to produce
a file whose reader will look at twenty rows.

So enrichment is split by what a request buys you.

**Tier 1** runs on everything with a corroborated site: `robots.txt`, the
sitemap, the homepage, the legal notice. Four requests, and they answer the
questions that decide whether a company deserves more: is the site alive, what
does it say it does, does it run a hiring pipeline, is its SIREN published there
(which independently confirms the register match).

**Tier 2** runs on the ones you chose. It walks the site by page ROLE and reads
the openings out of the ATS API. This is the pass that produces something worth
writing a dossier from.

```bash
ultraprospect enrich --run <dir> --tier 1
ultraprospect enrich --run <dir> --tier 2 --limit 20
ultraprospect enrich --run <dir> --tier 2 --only osm:n123,osm:n456
```

Without `--only`, tier 2 follows the score — spend the expensive pass where it
was earned.

## Page roles

URLs are classified by path, in French and English, and one page is taken per
role, preferring the section's landing page over an article inside it:

| Role | Matches |
|---|---|
| `careers` | careers, jobs, emplois, recrutement, nous-rejoindre, carrières |
| `pricing` | pricing, tarifs, prix, abonnements, plans, devis |
| `about` | about, à-propos, qui-sommes-nous, notre-histoire, entreprise |
| `team` | team, équipe, people, collaborateurs, direction |
| `contact` | contact, contactez-nous, nous-contacter |
| `legal` | mentions-légales, legal, impressum, cgv, cgu, confidentialité |
| `services` | services, prestations, expertises, solutions, savoir-faire, métiers |
| `products` | products, produits, boutique, shop, catalogue, collections |
| `cases` | case-studies, références, réalisations, portfolio, témoignages |
| `news` | news, blog, actualités, articles, presse |

The inventory comes from the sitemap **and** from the links on the homepage:
plenty of small sites have no sitemap, and the careers link is usually in the
footer.

## Job openings, without a browser

A careers page is usually an empty shell — the openings arrive from an
applicant-tracking system after load, so the HTML contains a heading and nothing
else. Rather than running a headless browser, the board token is discovered from
the links on the site and the openings are read from the provider's public API.

| Provider | Endpoint |
|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/<token>/jobs` |
| Lever | `api.lever.co/v0/postings/<token>?mode=json` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/<token>` |
| Recruitee | `<token>.recruitee.com/api/offers/` |
| Workable | `apply.workable.com/api/v1/widget/accounts/<token>?details=true` |
| Teamtailor | `<token>.teamtailor.com/jobs.json` |
| Welcome to the Jungle | detected only — no keyless API |

The token is always **discovered**, never guessed from the company name.
Guessing `boards.greenhouse.io/<slug>` would occasionally hit a different
company with a similar name and attribute their hiring to this prospect.

### The three hiring states

This distinction is load-bearing and easy to flatten:

- `isHiring: true` — openings were read. `openRoles` is a count of real postings.
- `isHiring: false` — we looked at the careers page and at the boards, and there
  were none. **A finding**, and a useful one.
- `isHiring` absent — a board was detected and could not be read. `atsProviders`
  names it. This is *our* loss of reach, not a fact about the company.

Never write "not hiring" for the third case.

## What is measured

Everything in `signals` is a count or a presence. The engine does not conclude:

- `pageCount`, `sitemapUrls`, `lastContentAt` (newest sitemap `lastmod`)
- `cms`, `analytics[]`, `techStack[]`, `hasEcommerce`, `hasPricingPage`
- `languages[]` from `<html lang>` and hreflang
- `legalIdOnSite` — a SIREN, SIRET or VAT number published on the site itself
- `socialProfiles[]` — profiles, not embedded videos and not share buttons

`lastContentAt` is a signal, not a guarantee: some generators stamp every page
with the build date, and its **absence is not staleness**.

## A site that answers but says nothing

`restaurant-elgringo.fr` returns HTTP 200 with **37 bytes**: a JavaScript shell
with no server-rendered content. It is a real, live website that a human can
open, and this tool cannot read a word of it.

Reporting that as "no website" would be wrong in a way the reader cannot see, so
it is its own outcome: the place keeps `website.confidence: "unverified"` with
the reason spelled out, `resolve` counts it separately from the absences, and
`enrich` notes it. Roughly one small-business site in ten is like this. It is a
prospect with a website you will have to open yourself, not a prospect without
one.

## Contacts

Verbatim only, each carrying the page id it came from.

- **Emails** come from `mailto:` hrefs and from the page text. Asset filenames
  (`logo@2x.png`) and placeholders (`nom@example.com`) are rejected.
- **Phone numbers come from `tel:` links and nothing else.** Scraping digit runs
  out of page text picks up SIRETs, prices, dates and opening hours, and a wrong
  number in a prospect file gets dialled.
- **Nothing is ever constructed.** No `prenom.nom@domaine` from a naming
  convention. The check gate re-reads every value against its page and fails the
  run when one does not appear there.

Values found in the markup rather than in the visible text are written into the
stored page file under "Contacts in the markup", so the cited artifact carries
its own evidence.

## Politeness

`robots.txt` is honoured for every page the walk discovers and follows. Sites
run concurrently (`--concurrency`, default 4) but the engine's per-host token
bucket still paces each host on its own, so two requests never land on one
server at the same moment.
