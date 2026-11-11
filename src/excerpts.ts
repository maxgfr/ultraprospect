// Quoting the page a fact was read from, so a citation can be checked without
// leaving the page.
//
// `[P1912]` beside an email address is the whole basis of the citation gate:
// `check` re-opens P1912 and fails the run when the address is not in it. But a
// reader holding only `index.html` could not do what the gate does — the id was
// a promise that the evidence exists somewhere, not the evidence. This module
// reads the stored extract and cuts the passage around the cited value, so the
// promise is redeemable in the same file.
//
// Two rules.
//
// ONLY WHAT WAS CITED. The run stores thousands of pages; quoting all of them
// would produce a fifteen-megabyte document. Only the pages some fact actually
// points at are read, which on a 2 500-company run is around two thousand.
//
// A MISS IS REPORTED, NEVER PAPERED OVER. When the value cannot be found in the
// extract, the quote says so instead of showing the top of the page as if it
// were the passage. A confident-looking excerpt that does not contain the thing
// it is evidence for is worse than no excerpt, because it invites a reader to
// stop checking.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pageDirFor } from "./pages.js";
import type { Place } from "./types.js";

/** The passage of one page that backs one cited value. */
export interface PageQuote {
  pageId: string;
  url?: string;
  role?: string;
  fetchedAt?: string;
  /** The passage around the value, whitespace collapsed. */
  text: string;
  /** False when the value is not in the stored extract — said out loud, not hidden. */
  located: boolean;
}

/** Quotes for a run, keyed by place, page and the value that was cited. */
export type QuoteIndex = Map<string, PageQuote>;

/**
 * Where a cited page came from, without its passage.
 *
 * Separate from the quote, and NOT rationed, because the two cost different
 * things and answer different questions. A passage is ~340 characters and lets
 * a reader judge whether the page means what the row claims; a URL is ~60 bytes
 * and lets them open it at all.
 *
 * Rationing both together is what produced 877 bare `[P42]` on a real run — ids
 * pointing at evidence the reader had no way to reach. A source you cannot open
 * is not a source, so the link is never the thing that gets cut.
 */
export interface PageRef {
  url?: string;
  role?: string;
  fetchedAt?: string;
}

/** Cited pages for a run, keyed by place and page. */
export type PageIndex = Map<string, PageRef>;

export function pageKey(placeId: string, pageId: string): string {
  return `${placeId} ${pageId}`;
}

/** What a rendered page can show about the evidence behind a run. */
export interface Evidence {
  quotes: QuoteIndex;
  pages: PageIndex;
}

export function quoteKey(placeId: string, pageId: string, value: string): string {
  return `${placeId}\u0000${pageId}\u0000${value}`;
}

/**
 * How much of the page to show on each side of the value.
 *
 * Enough to read the sentence the value sits in and judge whether the page
 * means what the row claims. 260 each side was measured at 2.8 MB across a
 * 2 500-company run; 170 keeps the sentence and its neighbours and costs
 * roughly a third less.
 */
const CONTEXT = 170;
/** Per place, so one company with forty published addresses cannot dominate. */
const QUOTES_PER_PLACE = 10;
/** Across the run, so a very large territory still produces an openable file. */
const QUOTES_TOTAL = 6000;

interface ParsedPage {
  url?: string;
  role?: string;
  fetchedAt?: string;
  body: string;
}

/**
 * Split an extract into its provenance header and its text.
 *
 * The header is written by pages.ts and is the reason a page read six weeks ago
 * can still be dated. Both halves matter here: the passage is the evidence, the
 * date is what says how old the evidence is.
 */
function parsePage(raw: string): ParsedPage {
  const cut = raw.indexOf("\n---\n");
  const head = cut === -1 ? raw : raw.slice(0, cut);
  const body = cut === -1 ? "" : raw.slice(cut + 5);
  const field = (name: string): string | undefined => head.match(new RegExp(`^- ${name}: (.+)$`, "m"))?.[1]?.trim();
  return { url: field("url"), role: field("role"), fetchedAt: field("fetched"), body };
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Where the value sits in the text.
 *
 * A phone number is stored normalised (`+49402294990`) and published spaced
 * (`040 8787 8655`), so a literal search would miss every phone in the run and
 * report each one as unlocatable. Digits are compared to digits.
 */
function locate(body: string, value: string): number {
  const direct = body.toLowerCase().indexOf(value.toLowerCase());
  if (direct !== -1) return direct;

  const digits = value.replace(/\D/g, "");
  if (digits.length < 6) return -1;
  // Walk the body's digits, remembering where each came from, then look for the
  // number's tail — a published local form drops the country code.
  const positions: number[] = [];
  let bodyDigits = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i]! >= "0" && body[i]! <= "9") {
      bodyDigits += body[i];
      positions.push(i);
    }
  }
  for (const probe of [digits, digits.slice(-9), digits.slice(-8)]) {
    if (probe.length < 6) continue;
    const at = bodyDigits.indexOf(probe);
    if (at !== -1) return positions[at]!;
  }
  return -1;
}

function excerpt(page: ParsedPage, value: string, pageId: string): PageQuote {
  const at = locate(page.body, value);
  const meta = { pageId, url: page.url, role: page.role, fetchedAt: page.fetchedAt };
  if (at === -1) {
    return {
      ...meta,
      located: false,
      text: `“${value}” does not appear in the stored extract of this page. The page is still the source recorded for it — read the whole extract rather than trusting a passage here.`,
    };
  }
  const from = Math.max(0, at - CONTEXT);
  const to = Math.min(page.body.length, at + value.length + CONTEXT);
  const lead = from > 0 ? "…" : "";
  const tail = to < page.body.length ? "…" : "";
  return { ...meta, located: true, text: `${lead}${collapse(page.body.slice(from, to))}${tail}` };
}

/** Every (page, value) pair some fact on this place points at. */
function citationsOf(place: Place): { pageId: string; value: string }[] {
  const out: { pageId: string; value: string }[] = [];
  const add = (pageId: string | undefined, value: string) => {
    if (pageId && /^(?:P\d+|osm:[nwr]\d+)$/.test(pageId)) out.push({ pageId, value });
  };
  // Term mentions carry their own surrounding line in `note`, so they do not
  // need a file read — but a quote from the page itself is longer and dated,
  // and the terms are the answer to the brief, so they are quoted too.
  for (const m of place.signals?.termMentions ?? []) add(m.from, m.value);
  for (const e of place.contacts.emails) add(e.from, e.value);
  for (const p of place.contacts.phones) add(p.from, p.value);
  for (const p of place.contacts.people) add(p.from, p.value);
  // Socials too. They were the one contact kind rendered without a source, so
  // they were never collected either; now that they cite their page like the
  // rest, leaving them out here would print an id with nothing behind it.
  for (const s of place.contacts.socials) add(s.from, s.value);
  // The legal identifier and the page `confirm` read it off. On a confirm-mode
  // run this is the most load-bearing citation there is — the register identity
  // is built on it — and it was the one page a company might cite nowhere else,
  // so its id rendered with nothing behind it.
  for (const id of place.legalIds ?? []) add(id.from, id.value);
  if (place.registryEvidence?.legalId) add(place.registryEvidence.from, place.registryEvidence.legalId);
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${c.pageId}\u0000${c.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Read the cited pages of these places and cut a passage for each citation.
 *
 * `places` should be the rows the page will actually show: quoting a company
 * that is not on the page costs bytes nobody can reach.
 */
export function collectEvidence(runDir: string, places: readonly Place[]): Evidence {
  const quotes: QuoteIndex = new Map();
  const refs: PageIndex = new Map();
  const parsed = new Map<string, ParsedPage | undefined>();
  let budget = QUOTES_TOTAL;

  for (const place of places) {
    let placeQuotes = 0;
    // EVERY citation gets its page read, not just the first ten. The file was
    // already being opened for the quotes; what is rationed is how much of it
    // travels, and a URL is not that.
    const citations = citationsOf(place);
    for (const { pageId, value } of citations) {
      const osm = /^osm:([nwr])(\d+)$/.exec(pageId);
      if (osm) {
        const featureType = osm[1] === "n" ? "node" : osm[1] === "w" ? "way" : "relation";
        refs.set(pageKey(place.id, pageId), { url: `https://www.openstreetmap.org/${featureType}/${osm[2]}` });
        continue;
      }
      const path = join(runDir, pageDirFor(place.id), `${pageId}.md`);
      if (!parsed.has(path)) {
        parsed.set(path, existsSync(path) ? parsePage(readFileSync(path, "utf8")) : undefined);
      }
      const page = parsed.get(path);
      // A page listed on the place but absent from disk is a real finding and
      // the dossier packet already reports it. Here it simply produces nothing:
      // an id with nothing behind it must not render as evidence.
      if (!page) continue;
      refs.set(pageKey(place.id, pageId), { url: page.url, role: page.role, fetchedAt: page.fetchedAt });
      // The passage stays rationed — per place so one company with forty
      // published addresses cannot dominate, and across the run so a large
      // territory still produces an openable file.
      if (placeQuotes < QUOTES_PER_PLACE && budget > 0) {
        quotes.set(quoteKey(place.id, pageId, value), excerpt(page, value, pageId));
        placeQuotes++;
        budget--;
      }
    }
  }
  return { quotes, pages: refs };
}
