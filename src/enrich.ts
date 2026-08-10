// Reading a company's own website, in two tiers.
//
// The tiers exist because of arithmetic. A small French town has around a
// thousand mapped businesses, two hundred of them with a website. Fetching
// eight pages each, at the per-host pacing that keeps this tool welcome, is six
// thousand requests and several hours — to produce a file whose reader will
// look at twenty rows.
//
//   TIER 1 runs on everything with a corroborated site. robots, sitemap,
//   home, legal notice. Four requests, and it answers the questions that
//   decide whether a company is worth more attention: is the site alive, what
//   does it say it does, does it run a hiring pipeline, is the SIREN on it.
//
//   TIER 2 runs on the ones you chose. It walks the site by PAGE ROLE — about,
//   services, products, pricing, careers, team, contact, news, cases — and
//   reads the openings out of the ATS API rather than out of a JavaScript
//   shell. This is the pass that produces something worth writing a dossier
//   from.
//
// Both honour robots.txt, both pace per host, and both store every page they
// read under a citable id. Nothing is summarised in memory and then asserted:
// if a claim cannot point at a page on disk, it does not survive the gate.
import { fetchSitemap, isAllowed, mapLimit, fetchRobots } from "./engine.js";
import { detectBoards, fetchAllBoards, type AtsBoard } from "./ats.js";
import { fetchPage, type FetchedPage, type PageStore } from "./pages.js";
import { buildSignals, extractEmails, extractPhones, extractSocials, roleOf, sameOriginLinks } from "./signals.js";
import type { JobPosting, PageRecord, PageRole, Place } from "./types.js";
import { uniqueBy } from "./util.js";

/** Tier 1: the pages every site is asked for. */
const TIER1_ROLES: PageRole[] = ["home", "legal"];

/** Tier 2: one page per role, in the order they earn their fetch. */
const TIER2_ROLES: PageRole[] = ["about", "services", "products", "pricing", "careers", "team", "contact", "cases", "news"];

/** Common legal-notice paths, tried when the sitemap does not name one. */
const LEGAL_GUESSES = ["/mentions-legales", "/mentions-legales/", "/legal", "/impressum", "/cgv", "/legal-notice"];

export interface EnrichOptions {
  tier: 1 | 2;
  /** Enrich at most this many places. */
  limit?: number;
  /** Only these place ids. */
  only?: string[];
  /** How many pages a tier-2 walk may fetch per site. */
  maxPages?: number;
  /** Sites to work on concurrently. Per-HOST pacing is separate and always on. */
  concurrency?: number;
  onNote?: (note: string) => void;
  onProgress?: (done: number, total: number, name: string) => void;
}

export interface EnrichOutcome {
  enriched: number;
  skipped: number;
  unreachable: number;
  pagesFetched: number;
  jobsFound: number;
  notes: string[];
}

/** Places with a website we proved is theirs. */
export function enrichable(places: readonly Place[]): Place[] {
  return places.filter((p) => p.website?.confidence === "corroborated");
}

interface SiteMap {
  urls: string[];
  lastContentAt?: string;
  count: number;
}

async function readSitemap(homeUrl: string): Promise<SiteMap> {
  try {
    const sitemap = await fetchSitemap(homeUrl, { max: 3 });
    const entries = sitemap?.urls ?? [];
    const lastmods = entries.map((u: { lastmod?: string }) => u.lastmod).filter((d): d is string => Boolean(d));
    return {
      urls: entries.map((u: { loc: string }) => u.loc),
      // The newest lastmod is a freshness signal, not a guarantee: plenty of
      // generators stamp every page with the build date. Its ABSENCE is not
      // staleness either, which is why the caller reports it as a date rather
      // than as "active" or "dormant".
      lastContentAt: lastmods.sort().at(-1),
      count: entries.length,
    };
  } catch {
    return { urls: [], count: 0 };
  }
}

/** Pick one URL per role from an inventory, nearest-to-root first. */
export function pickByRole(urls: readonly string[], roles: readonly PageRole[]): Map<PageRole, string> {
  const wanted = new Set(roles);
  const best = new Map<PageRole, string>();
  const depth = (u: string) => {
    try {
      return new URL(u).pathname.split("/").filter(Boolean).length;
    } catch {
      return 99;
    }
  };
  for (const url of urls) {
    const role = roleOf(url);
    if (!wanted.has(role)) continue;
    const current = best.get(role);
    // A section's landing page says more than one article inside it.
    if (!current || depth(url) < depth(current)) best.set(role, url);
  }
  return best;
}

async function enrichOne(
  runDir: string,
  place: Place,
  store: PageStore,
  opts: EnrichOptions,
): Promise<{ pages: PageRecord[]; jobs: number; reachable: boolean }> {
  const home = place.website!.url;
  const fetched: FetchedPage[] = [];
  const boards: AtsBoard[] = [];

  // robots.txt is honoured for the walk. `fetchPage` on a single cited URL is
  // following a citation rather than crawling, which is the distinction
  // webindex draws too — but everything we DISCOVER and then follow is a crawl,
  // and gets checked.
  const robots = await fetchRobots(home).catch(() => undefined);
  const allowed = (url: string) => (robots ? isAllowed(robots, url) : true);

  const sitemap = await readSitemap(home);

  const homePage = await fetchPage(runDir, place.id, home, "home", store, { keepHtml: true });
  if (!homePage) return { pages: [], jobs: 0, reachable: false };
  fetched.push(homePage);

  // Links off the homepage matter as much as the sitemap: plenty of small sites
  // have no sitemap at all, and a careers link is usually in the footer.
  const homeLinks = sameOriginLinks(homePage.html ?? "", homePage.record.url);
  const inventory = [...new Set([...sitemap.urls, ...homeLinks])];

  const roles = opts.tier === 1 ? TIER1_ROLES.filter((r) => r !== "home") : TIER2_ROLES;
  const picked = pickByRole(inventory, roles);

  // The legal notice is the highest-value page in tier 1 — it carries the SIREN
  // that corroborates the register match — and it is the one page a site
  // reliably has at a predictable path when the sitemap omits it.
  if (opts.tier === 1 && !picked.has("legal")) {
    for (const guess of LEGAL_GUESSES) {
      try {
        const url = new URL(guess, home).href;
        if (inventory.includes(url) || !allowed(url)) continue;
        picked.set("legal", url);
        break;
      } catch {
        // A base URL that will not parse has bigger problems.
      }
    }
  }

  const budget = opts.tier === 1 ? 2 : (opts.maxPages ?? TIER2_ROLES.length);
  let spent = 0;
  for (const [role, url] of picked) {
    if (spent >= budget) break;
    if (!allowed(url)) continue;
    const page = await fetchPage(runDir, place.id, url, role, store, { keepHtml: true });
    spent++;
    if (page) {
      fetched.push(page);
      boards.push(...detectBoards(page.html ?? "", page.record.url));
    }
  }
  boards.push(...detectBoards(homePage.html ?? "", homePage.record.url));

  const uniqueBoards = uniqueBy(boards, (b) => `${b.provider}:${b.token}`);
  const jobs: JobPosting[] = opts.tier === 2 ? await fetchAllBoards(uniqueBoards) : [];

  // ---- Fold everything onto the place ---------------------------------------
  for (const page of fetched) {
    place.contacts.emails.push(...extractEmails(page.text, page.html ?? "", page.record.id));
    place.contacts.phones.push(...extractPhones(page.html ?? "", page.record.id));
    place.contacts.socials.push(...extractSocials(page.html ?? "", page.record.id));
  }
  place.contacts.emails = uniqueBy(place.contacts.emails, (e) => e.value);
  place.contacts.phones = uniqueBy(place.contacts.phones, (p) => p.value);
  place.contacts.socials = uniqueBy(place.contacts.socials, (s) => s.value);
  place.jobs = jobs;
  place.pages = [...new Set([...place.pages, ...fetched.map((f) => f.record.id)])];
  place.signals = buildSignals({
    pages: fetched.map((f) => ({ record: f.record, text: f.text, html: f.html })),
    jobs,
    atsProviders: uniqueBoards.map((b) => b.provider),
    sitemapUrls: sitemap.count || undefined,
    lastContentAt: sitemap.lastContentAt,
    siteReachable: true,
  });

  return { pages: fetched.map((f) => f.record), jobs: jobs.length, reachable: true };
}

export async function runEnrich(runDir: string, places: Place[], store: PageStore, opts: EnrichOptions): Promise<EnrichOutcome> {
  const notes: string[] = [];
  const note = (n: string) => {
    notes.push(n);
    opts.onNote?.(n);
  };

  let targets = enrichable(places);
  if (opts.only?.length) {
    const wanted = new Set(opts.only);
    targets = targets.filter((p) => wanted.has(p.id));
  } else if (opts.tier === 2) {
    // Tier 2 without a selection follows the score, when there is one: the
    // whole point of the tier is to spend requests where they were earned.
    targets = [...targets].sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
  }
  if (opts.limit) targets = targets.slice(0, opts.limit);

  const outcome: EnrichOutcome = { enriched: 0, skipped: places.length - targets.length, unreachable: 0, pagesFetched: 0, jobsFound: 0, notes };
  if (targets.length === 0) {
    note("enrich: no place has a corroborated website yet — run `resolve` first");
    return outcome;
  }
  note(`enrich: tier ${opts.tier} over ${targets.length} site(s)`);

  let done = 0;
  // Sites run concurrently; the engine's per-host token bucket still paces each
  // host on its own, so this parallelises ACROSS companies without ever putting
  // two simultaneous requests on one server.
  await mapLimit(targets, opts.concurrency ?? 4, async (place) => {
    const result = await enrichOne(runDir, place, store, opts).catch(() => ({ pages: [] as PageRecord[], jobs: 0, reachable: false }));
    done++;
    opts.onProgress?.(done, targets.length, place.name);
    if (!result.reachable) {
      outcome.unreachable++;
      place.signals = {
        ...(place.signals ?? {
          hasWebsite: true,
          pageCount: 0,
          openRoles: 0,
          atsProviders: [],
          analytics: [],
          techStack: [],
          hasPricingPage: false,
          hasEcommerce: false,
          languages: [],
          socialProfiles: [],
        }),
        siteReachable: false,
      };
      return;
    }
    outcome.enriched++;
    outcome.pagesFetched += result.pages.length;
    outcome.jobsFound += result.jobs;
  });

  note(`enrich: ${outcome.enriched} site(s) read, ${outcome.pagesFetched} page(s) stored, ${outcome.jobsFound} opening(s), ${outcome.unreachable} unreachable`);
  return outcome;
}
