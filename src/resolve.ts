// Finding a company's own website — and proving it is theirs.
//
// Roughly four in five places arrive with no website: OSM only carries one when
// a mapper typed it in, and the register carries none at all. Everything the
// enrichment stage does grows from this URL, so getting it wrong does not
// produce a gap, it produces a whole dossier about somebody else's company.
//
// So no candidate is ever accepted on rank. A search engine putting a domain
// first means it matched some words; it is not evidence about who owns it. Each
// candidate is FETCHED and must corroborate itself against something only the
// real company would carry — its name in the page, its SIREN, or its street
// address. A candidate that cannot is recorded as unverified, with the reason,
// and the place keeps no website rather than a plausible one.
//
// Two lanes feed candidates, in this order:
//   1. The tag OSM already had — still only a claim, still corroborated.
//   2. The agent's own WebSearch, pooled into a JSON file and passed with
//      `--web-results`. The engine prints the queries to run; the agent runs
//      them; the engine ingests the hits. Same shape as ultrasearch.
//   3. webindex's keyless search, as a fallback when no hits were supplied.
import { search } from "./engine.js";
import { fetchPage, type PageStore } from "./pages.js";
import type { PageRecord, Place } from "./types.js";
import { foldAccents, normalizeName, tokenSet } from "./util.js";

/**
 * Hosts that are never a company's own website.
 *
 * A directory listing corroborates beautifully — pagesjaunes carries the name,
 * the address AND the phone number — which is exactly why it has to be excluded
 * by host rather than caught by the evidence check. Enriching from
 * societe.com would produce a dossier about a directory page.
 *
 * Social profiles are separated rather than discarded: for a small trader a
 * Facebook page is often the only web presence there is, and it belongs in
 * `contacts.socials`, not in `website`.
 */
const DIRECTORY_HOSTS = [
  "pagesjaunes.fr",
  "societe.com",
  "verif.com",
  "infogreffe.fr",
  "annuaire-entreprises.data.gouv.fr",
  "bodacc.fr",
  "manageo.fr",
  "kompass.com",
  "europages.fr",
  "yelp.",
  "tripadvisor.",
  "mappy.com",
  "petitfute.com",
  "justacote.com",
  "cylex-france.fr",
  "118712.fr",
  "hoodspot.fr",
  "dirigeants.bfmtv.com",
  "pappers.fr",
  "score3.fr",
  "leboncoin.fr",
  "amazon.",
  "ebay.",
  "doctolib.fr",
  "ubereats.com",
  "deliveroo.fr",
  "thefork.",
  "lafourchette.",
  "booking.com",
  "airbnb.",
  "indeed.com",
  "glassdoor.",
  // Public-sector and sector directories, all seen ranking above a company's
  // own site in real searches. education.gouv.fr's school annuaire is the one
  // that actually displaced a school's website in a Saint-Mandé run.
  "education.gouv.fr",
  "ville-data.com",
  "college-lycee.com",
  "adresses-ecoles.fr",
  "enseignement-prive.info",
  "restaurantguru.com",
  "restopolitan.com",
  "restaurants-de-france.fr",
  "uniiti.com",
  "kazfeed.com",
  "linternaute.com",
  "journaldunet.com",
  "figaro.fr",
  "wikipedia.org",
];

const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "tiktok.com", "pinterest.", "wa.me"];

export type HostKind = "own" | "directory" | "social";

export function classifyHost(url: string): HostKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "directory";
  }
  if (SOCIAL_HOSTS.some((h) => host.includes(h))) return "social";
  if (DIRECTORY_HOSTS.some((h) => host.includes(h))) return "directory";
  return "own";
}

/**
 * The search queries for one place.
 *
 * Distinct angles rather than rephrasings: the legal name and the shopfront
 * name are often different strings, and a company whose name is a common word
 * is only findable with its town attached.
 *
 * `fallbackTown` matters more than it looks. A register record always carries a
 * commune, but an OSM node usually has no `addr:city` at all — so without it the
 * query for a taqueria in Vincennes is the bare string "El Gringo", which finds
 * a restaurant in Mexico. The run's own territory is the right answer and we
 * always know it: the place was found inside it, by construction.
 */
export function queriesFor(place: Place, fallbackTown?: string): string[] {
  const town = place.address.commune ?? place.address.codePostal ?? fallbackTown ?? "";
  const names = new Set<string>();
  if (place.osm?.name) names.add(place.osm.name);
  for (const n of namesOf(place)) names.add(n);

  const queries: string[] = [];
  for (const n of names) {
    queries.push(town ? `${n} ${town}` : n);
  }
  // A quoted registration number is the highest-precision query there is: a page
  // carrying it is almost always the company's own legal-notice page. Which
  // number that is depends on the register — SIREN in France, company number in
  // the UK — so it comes off the record rather than out of a French constant.
  const legalId = place.registry?.establishmentId ?? place.registry?.id;
  if (legalId) queries.push(`"${legalId}"`);
  return [...new Set(queries)].slice(0, 3);
}

/**
 * Every name a register knows this place by, cleaned for searching.
 *
 * Trading name first: it is the sign over the door, which is what a search
 * engine has indexed. The parenthetical strip is for the French register's
 * habit of appending a disambiguator to `nom_complet`.
 */
function namesOf(place: Place): string[] {
  const rec = place.registry;
  if (!rec) return [];
  const out: string[] = [];
  const first = rec.tradingNames?.[0];
  if (first) out.push(first);
  if (rec.legalName) out.push(rec.legalName.replace(/\s*\([^)]*\)/g, "").trim());
  return out.filter(Boolean);
}

/** One place's search plan, as written to RESOLVE.todo.json. */
export interface ResolveTodoItem {
  placeId: string;
  name: string;
  queries: string[];
}

export interface ResolveTodo {
  version: 1;
  generatedAt: string;
  /**
   * What the agent has to go and search.
   *
   * A worklist file rather than just stdout, because that is what makes the
   * lane fannable: `orchestrate` walks it, hands each subagent a batch, and the
   * hits come back to one writer. Website discovery is the stage that decides
   * whether a run has any content at all — on a real Vincennes sweep, skipping
   * it left 11 corroborated sites out of 1164 — so it has to be as
   * orchestratable as adjudication and dossier-writing.
   */
  items: ResolveTodoItem[];
}

/** A hit the agent's WebSearch produced, or one of ours. */
export interface WebHit {
  url: string;
  title?: string;
  snippet?: string;
  /** Which place the hit is for, when the agent kept them grouped. */
  placeId?: string;
}

export interface Corroboration {
  ok: boolean;
  /** What was found on the page that ties it to this company. */
  evidence: string[];
  /** Why it was rejected, when it was. */
  reason?: string;
}

/**
 * Does this page belong to this company?
 *
 * Any ONE of three signals is enough, and they are ordered by how hard they are
 * to coincide with:
 *
 *   The registration number — conclusive. No other company carries it. Most of
 *     Europe legally requires it on the site: SIREN in France's mentions
 *     légales, the Handelsregister number in Germany's Impressum, the company
 *     number in the UK, the CIF in Spain's aviso legal. THE UNITED STATES HAS
 *     NO EQUIVALENT — an EIN is never published — so a US run loses the
 *     strongest signal here and leans on the two below. That is a real
 *     difference in what can be proven, not a gap to paper over.
 *   Street + postcode — near-conclusive. Two businesses can share a name; they
 *     do not share a doorway.
 *   Name — good, with a caveat: it must be the DISTINCTIVE part. "Pharmacie"
 *     appearing on a page called Pharmacie du Centre proves nothing, so generic
 *     tokens are dropped before matching and at least one distinctive token
 *     must survive and appear.
 */
export function corroborate(place: Place, pageText: string, pageTitle?: string): Corroboration {
  const haystack = foldAccents(`${pageTitle ?? ""}\n${pageText}`).toLowerCase();
  const digits = haystack.replace(/[^0-9]/g, "");
  const evidence: string[] = [];

  // Digits only, so formatting on the page ("123 456 789") cannot hide a match.
  // A register whose identifiers are not numeric (a UK company number can carry
  // a two-letter prefix) is matched on the raw text instead.
  const legalUnitId = place.registry?.id;
  const establishmentId = place.registry?.establishmentId;
  const carries = (id: string | undefined): boolean => {
    if (!id) return false;
    const bare = id.replace(/\s+/g, "");
    if (/^\d+$/.test(bare)) return bare.length >= 6 && digits.includes(bare);
    return bare.length >= 6 && haystack.includes(bare.toLowerCase());
  };
  if (carries(establishmentId)) evidence.push(`registration ${establishmentId} on the page`);
  else if (carries(legalUnitId)) evidence.push(`registration ${legalUnitId} on the page`);

  const street = place.address.libelleVoie;
  const postcode = place.address.codePostal;
  if (street && postcode) {
    const streetNorm = foldAccents(street)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const streetWords = streetNorm.split(" ").filter((w) => w.length > 3);
    const streetSeen = streetWords.length > 0 && streetWords.every((w) => haystack.includes(w));
    if (streetSeen && haystack.includes(postcode)) evidence.push(`address "${street} ${postcode}" on the page`);
  }

  const candidateNames = [place.osm?.name, ...namesOf(place)].filter((n): n is string => Boolean(n));
  for (const name of candidateNames) {
    const distinctive = [...tokenSet(normalizeName(name))].filter((t) => t.length >= 4);
    if (distinctive.length === 0) continue;
    if (distinctive.every((t) => haystack.includes(t))) {
      evidence.push(`name "${name}" on the page`);
      break;
    }
  }

  if (evidence.length === 0) {
    return { ok: false, evidence: [], reason: "the page carries neither the company's name, its address nor its SIREN" };
  }
  return { ok: true, evidence };
}

export interface ResolveOptions {
  /** Hits the agent produced with its own WebSearch. */
  webResults?: WebHit[];
  /** The run's territory, used when a place carries no address of its own. */
  town?: string;
  /** Only work on this many places. */
  limit?: number;
  /** Fall back to the engine's keyless search when no hits were supplied. */
  useEngineSearch?: boolean;
  onNote?: (note: string) => void;
  onProgress?: (done: number, total: number, name: string) => void;
}

export interface ResolveOutcome {
  /** Pages fetched while verifying, to be recorded on the run. */
  pages: Map<string, PageRecord[]>;
  corroborated: number;
  rejected: number;
  /** Reachable sites that serve no text without a browser. */
  jsOnly: number;
  unchanged: number;
  socials: number;
  notes: string[];
}

/** Places that still need a website, or whose website is only a mapper's claim. */
export function buildResolveTodo(places: readonly Place[], town?: string): ResolveTodo {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    items: needsResolving(places).map((p) => ({ placeId: p.id, name: p.name, queries: queriesFor(p, town) })),
  };
}

export function needsResolving(places: readonly Place[]): Place[] {
  return places.filter((p) => !p.website || p.website.confidence === "declared");
}

function candidateUrlsFor(place: Place, hits: readonly WebHit[]): string[] {
  const urls: string[] = [];
  if (place.website?.url) urls.push(place.website.url);
  for (const h of hits) urls.push(h.url);
  // Keep at most three: each costs a fetch, and past the third the ranking is
  // noise anyway.
  return [...new Set(urls)].slice(0, 3);
}

/** Group the agent's pooled hits by place, matching on the query it answered. */
export function groupHits(places: readonly Place[], hits: readonly WebHit[]): Map<string, WebHit[]> {
  const byPlace = new Map<string, WebHit[]>();
  const tagged = hits.filter((h) => h.placeId);
  if (tagged.length) {
    for (const h of tagged) {
      const list = byPlace.get(h.placeId!) ?? [];
      list.push(h);
      byPlace.set(h.placeId!, list);
    }
    return byPlace;
  }
  // Untagged pool: attribute each hit to the place whose distinctive name
  // tokens appear in its title or snippet. A hit that matches nothing is
  // dropped rather than assigned to the nearest guess.
  for (const place of places) {
    const names = [place.osm?.name, ...namesOf(place)].filter((n): n is string => Boolean(n));
    const tokens = names.flatMap((n) => [...tokenSet(normalizeName(n))].filter((t) => t.length >= 4));
    if (tokens.length === 0) continue;
    for (const h of hits) {
      const hay = foldAccents(`${h.title ?? ""} ${h.snippet ?? ""} ${h.url}`).toLowerCase();
      if (tokens.some((t) => hay.includes(t))) {
        const list = byPlace.get(place.id) ?? [];
        list.push(h);
        byPlace.set(place.id, list);
      }
    }
  }
  return byPlace;
}

export async function runResolve(runDir: string, places: Place[], store: PageStore, opts: ResolveOptions = {}): Promise<ResolveOutcome> {
  const notes: string[] = [];
  const note = (n: string) => {
    notes.push(n);
    opts.onNote?.(n);
  };
  const outcome: ResolveOutcome = { pages: new Map(), corroborated: 0, rejected: 0, jsOnly: 0, unchanged: 0, socials: 0, notes };

  const targets = needsResolving(places).slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
  const grouped = groupHits(targets, opts.webResults ?? []);
  if (opts.webResults?.length) note(`resolve: ${opts.webResults.length} supplied web result(s) attributed to ${grouped.size} place(s)`);
  else note("resolve: no --web-results supplied; only OSM-declared sites and the keyless fallback will be tried");

  let done = 0;
  for (const place of targets) {
    done++;
    opts.onProgress?.(done, targets.length, place.name);

    let hits = grouped.get(place.id) ?? [];
    if (hits.length === 0 && opts.useEngineSearch) {
      const query = queriesFor(place, opts.town)[0];
      if (query) {
        try {
          const res = await search(query, { limit: 3 });
          hits = (res.hits ?? []).map((h: { url: string; title?: string; snippet?: string }) => ({ url: h.url, title: h.title, snippet: h.snippet }));
        } catch {
          // A keyless engine being unavailable is not this place's problem.
        }
      }
    }

    const candidates = candidateUrlsFor(place, hits);
    if (candidates.length === 0) {
      outcome.unchanged++;
      continue;
    }

    let settled = false;
    for (const url of candidates) {
      const kind = classifyHost(url);
      if (kind === "social") {
        // Real signal, wrong field. A profile is not a website, and enriching
        // from one would produce a dossier about a social network's chrome.
        if (!place.contacts.socials.some((s) => s.value === url)) {
          place.contacts.socials.push({ value: url, from: "web", lane: "web", note: "found while resolving the website" });
          outcome.socials++;
        }
        continue;
      }
      if (kind === "directory") continue;

      const fetched = await fetchPage(runDir, place.id, url, "home", store);
      if (!fetched.ok) {
        // Same first-wins rule as a corroboration failure below.
        if (fetched.reason === "no-readable-text" && (!place.website || place.website.confidence !== "unverified")) {
          // The site is real and a human can open it; only we could not read
          // it. Recording "no website" here would be a false absence — measured
          // on restaurant-elgringo.fr, which answers 200 with 37 bytes.
          place.website = {
            url,
            confidence: "unverified",
            evidence: [`fetched HTTP ${fetched.status}, but the page carries ${fetched.chars} characters of text — a JavaScript-only site we cannot read`],
          };
          outcome.jsOnly++;
          settled = true;
        }
        continue;
      }
      const page = fetched.page;

      const check = corroborate(place, page.text, page.title);
      const list = outcome.pages.get(place.id) ?? [];
      list.push(page.record);
      outcome.pages.set(place.id, list);
      place.pages = [...new Set([...place.pages, page.record.id])];

      if (check.ok) {
        place.website = { url: page.record.url, confidence: "corroborated", evidence: [page.record.id, ...check.evidence] };
        outcome.corroborated++;
        settled = true;
        break;
      }
      // Keep the candidate visible, but never as a website, and keep the FIRST
      // one — candidates arrive best-ranked first, and letting a later
      // rejection overwrite an earlier one recorded a ministry's school
      // directory in place of the school's own domain, purely because it was
      // tried third.
      if (!place.website || place.website.confidence !== "unverified") {
        place.website = { url: page.record.url, confidence: "unverified", evidence: [page.record.id, check.reason ?? "no corroboration"] };
      }
      outcome.rejected++;
      settled = true;
    }
    if (!settled) outcome.unchanged++;
  }

  // The jsOnly count is reported separately from "left without a site" on
  // purpose: those companies HAVE a website, a human can open it, and only the
  // machine could not read it. Folding them into the absences would hide a
  // whole category of prospect behind a number that looks like coverage.
  note(
    `resolve: ${outcome.corroborated} corroborated, ${outcome.rejected} fetched but unverified, ` +
      `${outcome.jsOnly} reachable but JavaScript-only, ${outcome.socials} social profile(s), ` +
      `${outcome.unchanged} left without a site`,
  );
  return outcome;
}
