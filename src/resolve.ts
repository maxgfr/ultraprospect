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
// THREE lanes feed candidates, in this order:
//   1. The tag OSM already had — still only a claim, still corroborated.
//   2. The agent's own WebSearch, pooled into a JSON file and passed with
//      `--web-results`. The engine prints the queries to run; the agent runs
//      them; the engine ingests the hits. Same shape as ultrasearch, and the
//      main path — `resolve` refuses to run without it rather than quietly
//      doing the weak half.
//   3. webindex's keyless search, as a fallback when no hits were supplied.
//      It used to run ONE query and take three results. It now runs every query
//      this place has and fuses the lists with the engine's own Reciprocal Rank
//      Fusion, which is what makes a domain that two distinct angles both
//      surfaced beat one that a single angle ranked first.
//
// AND IT SEARCHES IN THE TERRITORY'S LANGUAGE. A run over Kreuzberg asking an
// engine in American English gets an American engine's idea of a Berlin
// bakery. The locale comes from the run's country, and the queries themselves
// carry a per-country angle: the words a legal-notice page is called in that
// language are often the only thing that surfaces a small company's own site.
import { dedupeByUrl, rrf, search } from "./engine.js";
import { legalNoticeTerms } from "./legal-notice.js";
import { describeSkips, partitionSkipped, type SkipOutcome } from "./skip.js";
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
 * SPLIT BY COUNTRY, because this list was ~90% French and silently stopped
 * filtering anything the moment a run left France. A Berlin sweep would have
 * enriched from gelbeseiten.de and produced a dossier about a phone book. The
 * international block applies everywhere; the national blocks are added for the
 * territory being swept.
 *
 * Social profiles are separated rather than discarded: for a small trader a
 * Facebook page is often the only web presence there is, and it belongs in
 * `contacts.socials`, not in `website`.
 */
const INTERNATIONAL_DIRECTORY_HOSTS = [
  "yelp.",
  "tripadvisor.",
  "kompass.com",
  "europages.",
  "booking.com",
  "airbnb.",
  "indeed.com",
  "glassdoor.",
  "amazon.",
  "ebay.",
  "thefork.",
  "opentable.",
  "ubereats.com",
  "wolt.com",
  "deliveroo.",
  "just-eat.",
  "lieferando.",
  "foursquare.com",
  "trustpilot.com",
  "crunchbase.com",
  "bloomberg.com",
  "dnb.com",
  "opencorporates.com",
  "wikipedia.org",
  "wikidata.org",
];

const DIRECTORY_HOSTS_BY_COUNTRY: Record<string, string[]> = {
  fr: [
    "pagesjaunes.fr",
    "societe.com",
    "verif.com",
    "infogreffe.fr",
    "annuaire-entreprises.data.gouv.fr",
    "bodacc.fr",
    "manageo.fr",
    "petitfute.com",
    "justacote.com",
    "cylex-france.fr",
    "118712.fr",
    "hoodspot.fr",
    "dirigeants.bfmtv.com",
    "pappers.fr",
    "score3.fr",
    // Company-record and annonces-légales sites, all harvested from LIVE French
    // searches over a Saint-Mandé sweep, where each of them ranked at or above
    // the company's own domain.
    //
    // These are the dangerous kind. A phone book carries a name and an address;
    // these publish the SIREN, so the corroboration check accepts them on the
    // strongest signal it has and files a register directory as the company's
    // own site, CORROBORATED rather than merely unverified. Host exclusion is
    // the only thing between that and a dossier written about a directory.
    "actulegales.fr",
    "data.inpi.fr",
    "rubypayeur.com",
    "societeinfo.com",
    "repreneurs.com",
    "infonet.fr",
    "datalegal.fr",
    "annuaire-inverse-france.com",
    "business-directory.fr",
    "compteo.fr",
    "petitesaffiches.fr",
    "maitredata.com",
    "droits-salaries.com",
    "afjv.com",
    "experts-comptables.org",
    "leboncoin.fr",
    "doctolib.fr",
    "mappy.com",
    "lafourchette.",
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
    // Trade and opening-hours directories, harvested from a live Saint-Mandé
    // search for two independent food businesses. Every one of these carries
    // the trading name AND the street address, so they corroborate on the two
    // strongest signals there are: left unlisted, alentoor.fr and
    // boulangeries-patisseries.fr were both filed as a company's own website,
    // CORROBORATED, in a real run.
    "alentoor.fr",
    "boulangeries-patisseries.fr",
    "trouver-ouvert.fr",
    "aleou.fr",
    "eater.space",
    "mapstr.com",
    "uniiti.com",
    "kazfeed.com",
    "linternaute.com",
    "journaldunet.com",
    "figaro.fr",
  ],
  de: [
    "gelbeseiten.de",
    "dasoertliche.de",
    "11880.com",
    "wlw.de",
    "firmenwissen.de",
    "northdata.de",
    "unternehmensregister.de",
    "meinestadt.de",
    "goyellow.de",
    "cylex.de",
    "werkenntdenbesten.de",
    "jameda.de",
    "kununu.com",
    "stepstone.de",
  ],
  es: ["paginasamarillas.es", "einforma.com", "axesor.es", "empresite.eleconomista.es", "infoempresa.com", "cylex.es", "11870.com", "infojobs.net"],
  gb: ["yell.com", "companycheck.co.uk", "endole.co.uk", "checkatrade.com", "thomsonlocal.com", "cylex-uk.co.uk", "192.com", "reed.co.uk", "totaljobs.com"],
  us: [
    "yellowpages.com",
    "bbb.org",
    "manta.com",
    "bizapedia.com",
    "chamberofcommerce.com",
    "mapquest.com",
    "angi.com",
    "thumbtack.com",
    "zillow.com",
    "ziprecruiter.com",
  ],
  it: ["paginegialle.it", "ufficiocamerale.it", "reportaziende.it", "misterimprese.it"],
  nl: ["telefoonboek.nl", "detelefoongids.nl", "bedrijvenpagina.nl"],
  no: ["gulesider.no", "proff.no", "1881.no"],
  fi: ["fonecta.fi", "finder.fi"],
  cz: ["firmy.cz", "zivefirmy.cz"],
  pl: ["panoramafirm.pl", "aleo.com", "pkt.pl"],
};

const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "tiktok.com", "pinterest.", "wa.me"];

export type HostKind = "own" | "directory" | "social";

/**
 * How many distinct angles to search per place.
 *
 * Three is the default because the agent runs every one of these by hand and a
 * two-thousand-place sweep at five angles is ten thousand searches. It is a
 * BUDGET, not a claim that three is enough: an aimed run of forty cafés can
 * afford five, and the flag exists so that choice is the caller's.
 */
export const DEFAULT_QUERIES_PER_PLACE = 3;

/** The hosts to exclude for a territory: the international core plus that country's own. */
export function directoryHostsFor(countryCode: string | undefined): string[] {
  const national = DIRECTORY_HOSTS_BY_COUNTRY[(countryCode ?? "").toLowerCase()] ?? [];
  return [...INTERNATIONAL_DIRECTORY_HOSTS, ...national];
}

export function classifyHost(url: string, countryCode?: string): HostKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "directory";
  }
  if (SOCIAL_HOSTS.some((h) => host.includes(h))) return "social";
  if (directoryHostsFor(countryCode).some((h) => host.includes(h))) return "directory";
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
export function queriesFor(place: Place, fallbackTown?: string, countryCode?: string, perPlace = DEFAULT_QUERIES_PER_PLACE): string[] {
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

  const firstName = [...names][0];

  // The street, where a mapper or the register recorded one.
  //
  // This outranks the legal-notice angle BECAUSE it is evidence rather than a
  // hope. A café is not obliged to publish mentions légales and mostly does
  // not, so that query spends one of very few slots on a page that will not
  // exist; the door number is a fact about this business that its own site,
  // its listing and its social page all tend to repeat. Where there is no
  // street we have nothing to spend, and the legal notice is the best guess
  // left — which is exactly the German case the angle was written for.
  const street = place.address.libelleVoie;
  if (street && firstName) {
    const numero = place.address.numero ? `${place.address.numero} ` : "";
    queries.push(`${firstName} ${numero}${street}${town ? ` ${town}` : ""}`.trim());
  }

  // Where no register swept the territory there IS no number to quote, and the
  // strongest remaining angle is the page the law makes mandatory: only a
  // company's own site has an Impressum for that company.
  if (!legalId && firstName) {
    for (const term of legalNoticeTerms(countryCode)) queries.push(`${firstName} ${term}`);
  }
  return [...new Set(queries)].slice(0, Math.max(1, perPlace));
}

/**
 * The BCP-47 tag the search engines should answer in.
 *
 * A run over Kreuzberg asking in American English gets an American engine's
 * idea of a Berlin bakery, and the company's own German-language site is not on
 * the first page. `--lang` wins when given; otherwise the territory's country
 * decides, which is right far more often than a global default.
 */
export function searchLocaleFor(countryCode: string | undefined, lang?: string): string | undefined {
  if (lang) return lang;
  const cc = (countryCode ?? "").toLowerCase();
  const byCountry: Record<string, string> = {
    fr: "fr-FR",
    de: "de-DE",
    at: "de-AT",
    ch: "de-CH",
    es: "es-ES",
    it: "it-IT",
    nl: "nl-NL",
    be: "nl-BE",
    pt: "pt-PT",
    pl: "pl-PL",
    cz: "cs-CZ",
    no: "nb-NO",
    fi: "fi-FI",
    se: "sv-SE",
    dk: "da-DK",
    gb: "en-GB",
    ie: "en-IE",
    us: "en-US",
  };
  return byCountry[cc];
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
  /**
   * The places `--skip` kept out of `items`, each with the reasons that applied.
   *
   * Written rather than merely counted, because a skip is a decision about
   * where to spend searches and it has to be REVERSIBLE: a reader who disagrees
   * that a row is a chain needs the id and the reason to argue with, not a
   * total. Absent when no reasons were asked for.
   */
  skipped?: { placeId: string; name: string; reasons: string[] }[];
}

/** A hit the agent's WebSearch produced, or one of ours. */
export interface WebHit {
  url: string;
  title?: string;
  snippet?: string;
  /** Which place the hit is for, when the agent kept them grouped. */
  placeId?: string;
}

/**
 * One doorway, normalised, or "" when the place has no street address.
 *
 * Number + street + postcode, because that is the granularity at which "the
 * same address" means the same entrance. The commune is redundant with the
 * postcode and spelled inconsistently between the two lanes.
 */
export function addressKey(place: Place): string {
  const a = place.address;
  if (!a.libelleVoie || !a.codePostal) return "";
  return `${a.numero ?? ""}|${foldAccents(a.libelleVoie).toUpperCase().trim()}|${a.codePostal}`;
}

/**
 * The addresses this run found more than one company at.
 *
 * Business centres, coworking floors and domiciliation services are not edge
 * cases: on a Saint-Mandé sweep 62 of 86 companies shared an address with
 * another company in the same run, 36 of them at a single building. So "two
 * businesses do not share a doorway" cannot be assumed — but it can be
 * MEASURED, and measured from the run's own register records rather than from a
 * list of known business centres that would need maintaining and would still
 * miss the next one.
 */
export function sharedAddressesIn(places: readonly Place[]): Set<string> {
  const seen = new Map<string, number>();
  for (const p of places) {
    const key = addressKey(p);
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([key]) => key));
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
export function corroborate(place: Place, pageText: string, pageTitle?: string, sharedAddresses: ReadonlySet<string> = new Set()): Corroboration {
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
  // An address only distinguishes a company from the others when it is HERS.
  // Where this run has already found several companies behind the same door,
  // it has measured that this one does not, so the signal is dropped here
  // rather than believed and explained away downstream.
  if (street && postcode && !sharedAddresses.has(addressKey(place))) {
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
  /** The run's country. Decides the directory blocklist, the query angles and the search locale. */
  countryCode?: string;
  /** BCP-47 override for the search locale, from `--lang`. */
  lang?: string;
  /** Only work on this many places. */
  limit?: number;
  /** Only work on these place ids. See `resolveTargets`. */
  only?: readonly string[];
  /** Skip reasons applied before any search is spent. See `src/skip.ts`. */
  skip?: readonly string[];
  /** Distinct search angles per place. Defaults to DEFAULT_QUERIES_PER_PLACE. */
  queriesPerPlace?: number;
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
  /** Places whose ONLY proven presence is a social profile. A state, not a gap. */
  socialOnly: number;
  /** Reachable sites that serve no text without a browser. */
  jsOnly: number;
  /**
   * Candidates whose host turned us away, or never answered.
   *
   * Counted on its own because it is neither a rejection nor an absence: we
   * learned nothing about the page. Folding it into "left without a site" would
   * report a door we could not open as a company with no web presence.
   */
  unreadable: number;
  unchanged: number;
  socials: number;
  notes: string[];
}

/**
 * Places that still need a website, or whose website is only a mapper's claim.
 *
 * The selection is applied HERE rather than by the caller slicing the result,
 * because this worklist is what `orchestrate --phase resolve` fans out over. A
 * todo listing places the fold will then refuse to work on dispatches subagents
 * at searches nobody will use.
 */
export function buildResolveTodo(places: readonly Place[], town?: string, countryCode?: string, selection: ResolveSelection = {}): ResolveTodo {
  const outcome = skipOutcomeFor(places, selection);
  const byId = new Map(places.map((p) => [p.id, p]));
  const skipped = [...outcome.skipped].map(([placeId, reasons]) => ({ placeId, name: byId.get(placeId)?.name ?? placeId, reasons }));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    items: resolveTargets(places, selection).map((p) => ({
      placeId: p.id,
      name: p.name,
      queries: queriesFor(p, town, countryCode, selection.queriesPerPlace),
    })),
    ...(skipped.length ? { skipped } : {}),
  };
}

export function needsResolving(places: readonly Place[]): Place[] {
  return places.filter((p) => !p.website || p.website.confidence === "declared");
}

/** Which ids the caller narrowed the lane to, and how many of them to take. */
export interface ResolveSelection {
  /** Place ids to resolve. Empty or absent means every place that needs one. */
  only?: readonly string[];
  /**
   * Skip reasons to apply before spending searches: chain, unnamed, public,
   * vacant. Each reads a tag a mapper asserted — see `src/skip.ts`.
   */
  skip?: readonly string[];
  /** Ceiling, applied AFTER the selection — the same order `enrich` uses. */
  limit?: number;
  /** Distinct search angles per place. Defaults to DEFAULT_QUERIES_PER_PLACE. */
  queriesPerPlace?: number;
}

/**
 * The places this lane will actually work on.
 *
 * `only` exists because `limit` alone is not a choice, it is a prefix. This
 * lane is sequential and fetches per place, so on a territory of any size it
 * has to be pointed somewhere — and the companies worth pointing it at are
 * scattered through `places.json` in whatever order the sweep returned. A
 * Hamburg run holds 2504 offices; the 97 tagged `office=it` are not the first
 * 97. `enrich` has taken `--only` since it existed; the slower lane, and the
 * one the whole run rests on, could not be aimed at all.
 *
 * Narrowing only ever removes work: a place with a corroborated site is not
 * re-resolved because the caller named it. That keeps the flag from being a
 * way to re-run a lane over settled evidence.
 */
export function resolveTargets(places: readonly Place[], opts: ResolveSelection = {}): Place[] {
  const targets = skipOutcomeFor(places, opts).kept;
  return opts.limit ? targets.slice(0, opts.limit) : targets;
}

/**
 * The skip partition for a SELECTION, not for the whole run.
 *
 * The distinction is the whole value of the number. `--only` has already
 * decided which places this invocation is about, so a skip count taken over
 * every place in `places.json` describes work the user never asked for — it
 * would report 81 rows skipped on a run that was only ever going to search
 * three. One function so the worklist and the fold cannot disagree.
 *
 * Skipping runs AFTER `--only`: the two are different questions, and a caller
 * who wants a chain resolved anyway drops the reason rather than fighting the
 * id list.
 */
export function skipOutcomeFor(places: readonly Place[], opts: ResolveSelection = {}): SkipOutcome {
  let targets = needsResolving(places);
  if (opts.only?.length) {
    const wanted = new Set(opts.only);
    targets = targets.filter((p) => wanted.has(p.id));
  }
  if (!opts.skip?.length) return { kept: targets, skipped: new Map(), counts: {} };
  return partitionSkipped(targets, opts.skip);
}

/** How many fetchable candidates one place is worth. Each costs a request. */
const MAX_FETCHED_CANDIDATES = 3;

/** How many social profiles to keep. They cost no request, but they are not free of noise. */
const MAX_SOCIAL_CANDIDATES = 5;

/**
 * The URLs worth looking at for one place, in the order they will be tried.
 *
 * SOCIAL PROFILES COME FIRST AND ARE NEVER CAPPED. They cost nothing — the loop
 * records them and moves on without fetching — and they were being lost twice
 * over. Measured on a live search for a Saint-Mandé bakery: the top three hits
 * were rubypayeur, pagesjaunes and aleou, and the company's own Facebook page
 * was fourth, so a cap over the raw ranked list threw away the only real signal
 * there was. For a local trader a Facebook page is very often the ENTIRE web
 * presence, which makes it the last thing that should lose a slot to a phone
 * book.
 *
 * The cap on fetchable candidates is deliberately still applied over the ranked
 * list INCLUDING known directories. Dropping them first to "free up" slots was
 * tried and is worse: it pulls unlisted directories up into the freed slots,
 * and a directory corroborates beautifully — it carries the name AND the
 * address — so it gets filed as the company's own website. Measured on the same
 * two businesses: alentoor.fr and boulangeries-patisseries.fr were both
 * recorded as `corroborated`, which is precisely the failure the host blocklist
 * exists to prevent. A blocklist can never be complete, so the budget stays
 * small and rank-ordered, and being crowded out by a known directory is the
 * cheap failure rather than the expensive one.
 */
function candidateUrlsFor(place: Place, hits: readonly WebHit[], countryCode?: string): string[] {
  const urls: string[] = [];
  if (place.website?.url) urls.push(place.website.url);
  for (const h of hits) urls.push(h.url);

  const socials: string[] = [];
  const rest: string[] = [];
  for (const url of new Set(urls)) {
    if (classifyHost(url, countryCode) === "social") socials.push(url);
    else rest.push(url);
  }
  // Free is not the same as unlimited: the hits are whatever the agent pooled,
  // and a sloppy pool can carry a dozen profiles for one shop. Enough to hold a
  // Facebook page, an Instagram and a LinkedIn without the contact list turning
  // into a search dump.
  return [...socials.slice(0, MAX_SOCIAL_CANDIDATES), ...rest.slice(0, MAX_FETCHED_CANDIDATES)];
}

/**
 * The keyless fallback, pooled the way ultrasearch pools.
 *
 * It used to run ONE query and take three results, which is a fallback in name
 * only: the queries this tool generates are deliberately DIFFERENT ANGLES on
 * the same company — the shopfront name, the legal name, the registration
 * number, the legal-notice page — and throwing away all but the first discards
 * the diversity that makes them worth generating.
 *
 * Every query runs, and the ranked lists are fused with the engine's own
 * Reciprocal Rank Fusion. RRF reads POSITION rather than score, which is what
 * makes it correct here: a keyless engine's relevance number is not comparable
 * across queries, but "this domain came third for the name AND second for the
 * registration number" is exactly the signal that identifies a company's own
 * site.
 */
async function keylessHits(queries: readonly string[], locale: string | undefined, onEngineNote?: (note: string) => void): Promise<WebHit[]> {
  const lists: WebHit[][] = [];
  for (const query of queries) {
    try {
      const res = await search(query, { limit: 5, lang: locale });
      // What the cascade says about ITSELF has to reach the run.
      //
      // These notes used to be dropped on the floor, and the one that matters
      // says the engines refused to answer. Without it a blocked search and a
      // territory with no web presence produce the same output — 12 companies
      // searched, 0 found, "left without a site" — and the reader has no way to
      // tell which they are looking at.
      //
      // The local-stack advice is filtered out: SearXNG and Firecrawl are
      // localhost and off by default, so the cascade mentions them on every
      // single query. That is a note about this machine's Docker, not a finding
      // about a territory, and repeating it per place would bury the one that is.
      for (const n of res.notes ?? []) if (!/searxng|firecrawl|stack up/i.test(n)) onEngineNote?.(n);
      lists.push((res.hits ?? []).map((h: { url: string; title?: string; snippet?: string }) => ({ url: h.url, title: h.title, snippet: h.snippet })));
    } catch {
      // A keyless engine being unavailable is not this place's problem.
    }
  }
  if (lists.length === 0) return [];

  const byUrl = new Map<string, WebHit>();
  for (const list of lists) for (const hit of list) if (!byUrl.has(hit.url)) byUrl.set(hit.url, hit);
  const fused = rrf(lists, (h) => h.url);
  const ranked = [...byUrl.values()].map((hit) => ({ ...hit, score: fused.get(hit.url) ?? 0 })).sort((a, b) => b.score - a.score);
  // `dedupeByUrl` canonicalises before comparing, so `example.com/?utm_source=…`
  // and `example.com/` collapse — which a plain Map keyed on the raw URL does
  // not do, and which is most of the duplication a pooled search produces.
  return dedupeByUrl(ranked).items.map(({ url, title, snippet }) => ({ url, title, snippet }));
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
  // Untagged pool: attribute each hit to the place whose distinctive name tokens
  // appear in it. A hit that matches nothing is dropped rather than assigned to
  // the nearest guess.
  //
  // Two rules, and the split between them is what a URL can honestly prove:
  //
  //   TEXT (title and snippet) is matched WORD BY WORD. Substring matching read
  //     "national" out of "UBISOFT INTERNATIONAL" and handed Ubisoft's careers
  //     page to the CNRS on a live Saint-Mandé run; the page then corroborated
  //     on a shared street address and became the CNRS's website.
  //   THE HOST is matched as a substring, because that is how domains spell a
  //     company name — matchtune.com for MATCH TUNE. The PATH is not matched at
  //     all: `actulegales.fr/recherche/siren/…` is that directory's own
  //     vocabulary, and it went to the CNRS for the word "recherche".
  for (const place of places) {
    const names = [place.osm?.name, ...namesOf(place)].filter((n): n is string => Boolean(n));
    const tokens = names.flatMap((n) => [...tokenSet(normalizeName(n))].filter((t) => t.length >= 4));
    if (tokens.length === 0) continue;
    for (const h of hits) {
      const words = new Set(
        foldAccents(`${h.title ?? ""} ${h.snippet ?? ""}`)
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean),
      );
      let host = "";
      try {
        host = foldAccents(new URL(h.url).hostname).toLowerCase();
      } catch {
        // A malformed URL contributes no host; the text rule still applies.
      }
      if (tokens.some((t) => words.has(t) || (host !== "" && host.includes(t)))) {
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
  // The search cascade says the same thing on every query — one place with three
  // queries would repeat it three times, a town with eight hundred, twice that.
  // It is one fact about the run, so it is recorded once.
  const saidByEngine = new Set<string>();
  const engineNote = (n: string) => {
    if (saidByEngine.has(n)) return;
    saidByEngine.add(n);
    note(`resolve: the keyless fallback reports — ${n}`);
  };
  const outcome: ResolveOutcome = { pages: new Map(), corroborated: 0, rejected: 0, jsOnly: 0, unreadable: 0, unchanged: 0, socials: 0, socialOnly: 0, notes };

  const locale = searchLocaleFor(opts.countryCode, opts.lang);
  if (opts.useEngineSearch && locale) note(`resolve: the keyless fallback will search in ${locale}`);

  // Computed over EVERY place in the run, not just the ones being resolved: a
  // company sharing a door with one the caller filtered out still shares it.
  const shared = sharedAddressesIn(places);
  if (shared.size) note(`resolve: ${shared.size} address(es) hold more than one company in this run — an address alone will not corroborate a site for those`);

  // Reported before the lane runs, and in the same terms the todo file records,
  // so the number of searches NOT spent is as visible as the ones that were.
  if (opts.skip?.length) {
    const line = describeSkips(skipOutcomeFor(places, opts), Boolean(opts.limit));
    if (line) note(`resolve: ${line}`);
  }

  const targets = resolveTargets(places, opts);
  const grouped = groupHits(targets, opts.webResults ?? []);
  if (opts.webResults?.length) note(`resolve: ${opts.webResults.length} supplied web result(s) attributed to ${grouped.size} place(s)`);
  else note("resolve: no --web-results supplied; only OSM-declared sites and the keyless fallback will be tried");

  let done = 0;
  for (const place of targets) {
    done++;
    opts.onProgress?.(done, targets.length, place.name);

    let hits = grouped.get(place.id) ?? [];
    if (hits.length === 0 && opts.useEngineSearch) {
      hits = await keylessHits(queriesFor(place, opts.town, opts.countryCode, opts.queriesPerPlace), locale, engineNote);
    }

    const candidates = candidateUrlsFor(place, hits, opts.countryCode);
    if (candidates.length === 0) {
      outcome.unchanged++;
      continue;
    }

    let settled = false;
    for (const url of candidates) {
      const kind = classifyHost(url, opts.countryCode);
      if (kind === "social") {
        // Real signal, wrong field. A profile is not a website, and enriching
        // from one would produce a dossier about a social network's chrome.
        const social = { value: url, from: "web", lane: "web" as const, note: "found while resolving the website" };
        const existing = place.contacts.socials.findIndex((item) => item.value === url);
        if (existing === -1) {
          place.contacts.socials.push(social);
          outcome.socials++;
        } else if (place.contacts.socials[existing]!.lane !== "web") {
          place.contacts.socials[existing] = social;
          outcome.socials++;
        }
        continue;
      }
      if (kind === "directory") continue;

      const fetched = await fetchPage(runDir, place.id, url, "home", store);
      if (!fetched.ok) {
        // A host that turned us away, or never answered, teaches us NOTHING
        // about whose site this is — so it must not become the place's website,
        // not even as a candidate. data.inpi.fr answered 403 on a real run and
        // was filed as this company's website, unverified; a register directory
        // then sat in the CSV under the `website` column.
        //
        // It is still counted, because silence about it would put the company
        // in "left without a site" — which is a claim about the company rather
        // than about the fetch.
        if (fetched.reason !== "no-readable-text") {
          outcome.unreadable++;
          continue;
        }
        // Same first-wins rule as a corroboration failure below.
        if (!place.website || place.website.confidence !== "unverified") {
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

      const check = corroborate(place, page.text, page.title, shared);
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

  // What the search actually found, recorded per place rather than only summed.
  //
  // Only for the places this invocation SEARCHED FOR. That is the whole value
  // of the field: `none` then means "we looked and found nothing", which is a
  // finding, while absence means nobody has looked yet. Setting it on every
  // place in the run would collapse the two, and "has no website" is exactly
  // the kind of claim someone will act on.
  for (const place of targets) {
    place.webPresence =
      place.website?.confidence === "corroborated" ? "own-site" : place.contacts.socials.some((social) => social.lane === "web") ? "social-only" : "none";
    if (place.webPresence === "social-only") outcome.socialOnly++;
  }

  // The jsOnly count is reported separately from "left without a site" on
  // purpose: those companies HAVE a website, a human can open it, and only the
  // machine could not read it. Folding them into the absences would hide a
  // whole category of prospect behind a number that looks like coverage.
  note(
    `resolve: ${outcome.corroborated} corroborated, ${outcome.rejected} fetched but unverified, ` +
      `${outcome.jsOnly} reachable but JavaScript-only, ${outcome.unreadable} candidate(s) refused or unreachable, ` +
      `${outcome.socials} social profile(s), ${outcome.unchanged} left without a site`,
  );
  // Called out on its own line because it is the one outcome that reads as a
  // gap and is not: these businesses HAVE a web presence, it is simply not a
  // site of their own.
  if (outcome.socialOnly) {
    note(`resolve: ${outcome.socialOnly} place(s) whose only proven presence is a social profile — a state, not a gap`);
  }
  return outcome;
}
