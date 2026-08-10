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
 */
export function queriesFor(place: Place): string[] {
  const town = place.address.commune ?? place.address.codePostal ?? "";
  const names = new Set<string>();
  if (place.osm?.name) names.add(place.osm.name);
  if (place.sirene?.enseignes[0]) names.add(place.sirene.enseignes[0]);
  if (place.sirene?.nomComplet) names.add(place.sirene.nomComplet.replace(/\s*\([^)]*\)/g, "").trim());

  const queries: string[] = [];
  for (const n of names) {
    queries.push(town ? `${n} ${town}` : n);
  }
  // The SIREN is the highest-precision query there is: a page carrying it is
  // almost always the company's own legal-notice page.
  if (place.sirene?.siren) queries.push(`"${place.sirene.siren}"`);
  return [...new Set(queries)].slice(0, 3);
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
 *   SIREN/SIRET — conclusive. French sites must publish it in their legal
 *     notice, and no other company carries the same number.
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

  const siren = place.sirene?.siren;
  const siret = place.sirene?.siret;
  if (siret && digits.includes(siret)) evidence.push(`SIRET ${siret} on the page`);
  else if (siren && digits.includes(siren)) evidence.push(`SIREN ${siren} on the page`);

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

  const candidateNames = [place.osm?.name, place.sirene?.enseignes[0], place.sirene?.nomComplet].filter((n): n is string => Boolean(n));
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
  unchanged: number;
  socials: number;
  notes: string[];
}

/** Places that still need a website, or whose website is only a mapper's claim. */
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
    const names = [place.osm?.name, place.sirene?.enseignes[0], place.sirene?.nomComplet].filter((n): n is string => Boolean(n));
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
  const outcome: ResolveOutcome = { pages: new Map(), corroborated: 0, rejected: 0, unchanged: 0, socials: 0, notes };

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
      const query = queriesFor(place)[0];
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

      const page = await fetchPage(runDir, place.id, url, "home", store);
      if (!page) continue;

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
      // Keep the candidate visible, but never as a website. A named reason is
      // what lets someone re-open the decision later.
      place.website = { url: page.record.url, confidence: "unverified", evidence: [page.record.id, check.reason ?? "no corroboration"] };
      outcome.rejected++;
      settled = true;
    }
    if (!settled) outcome.unchanged++;
  }

  note(
    `resolve: ${outcome.corroborated} corroborated, ${outcome.rejected} fetched but unverified, ${outcome.socials} social profile(s), ${outcome.unchanged} left without a site`,
  );
  return outcome;
}
