// Fetched pages, stored so they can be cited.
//
// Every page this tool reads is written to disk under a stable id (`P1`, `P2`,
// …) inside the run. That is the whole basis of the citation gate: a dossier
// claims something and points at `[P3]`, and `check` re-opens `P3` to see
// whether it says that. A summary held only in a model's context cannot be
// re-opened, so nothing downstream may depend on one.
//
// The extract file carries its own provenance header — url, fetch time,
// extractor, HTTP status — because a page read six weeks ago is not the page
// that is there now, and a claim about a company's hiring is only as good as
// the date underneath it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cachedFetchAndExtract, fetchAndExtract, isNoWrite, writeArtifact } from "./engine.js";
import { politeUa } from "./net.js";
import type { PageRecord, PageRole } from "./types.js";

/** Where a place's pages live inside the run, relative to its root. */
export function pageDirFor(placeId: string): string {
  return join("pages", placeId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

export interface FetchedPage {
  record: PageRecord;
  text: string;
  title?: string;
  /** Raw HTML, when the caller asked to keep it (link and signal extraction). */
  html?: string;
}

export interface PageStore {
  /** Next free id, shared across every place in the run. */
  next: number;
}

export function newPageStore(existing: readonly PageRecord[] = []): PageStore {
  const highest = existing.reduce((max, p) => Math.max(max, Number.parseInt(p.id.slice(1), 10) || 0), 0);
  return { next: highest + 1 };
}

/**
 * Fetch a URL and store it as a citable page.
 *
 * Returns undefined when the fetch produced nothing usable — a 404, a
 * challenge page, an empty body. That is a normal outcome for a third of small
 * business sites and is reported as absence, never filled in from elsewhere.
 */
export async function fetchPage(
  runDir: string,
  placeId: string,
  url: string,
  role: PageRole,
  store: PageStore,
  opts: { keepHtml?: boolean; timeoutMs?: number } = {},
): Promise<FetchedPage | undefined> {
  // Two fetchers, chosen by whether the caller needs the raw HTML.
  //
  // The cached path is the default and the right one for text: a `watch` run
  // over the same territory re-reads hundreds of pages that have not changed.
  // But the cache stores the EXTRACT, not the bytes, so it cannot serve HTML —
  // and HTML is what carries the things text extraction deliberately throws
  // away: the `<meta generator>`, the analytics script tags, the ATS board
  // link, the `rel=me` social links. A caller that needs those takes the
  // uncached path knowingly rather than getting silently-absent signals.
  //
  // Company sites also keep the engine's default browser User-Agent. The
  // identifying one is for OSM and data.gouv (see src/net.ts); plenty of
  // commercial hosts serve a challenge page to anything that looks automated,
  // and a prospect's marketing site is not community infrastructure.
  let result: Awaited<ReturnType<typeof fetchAndExtract>>;
  try {
    result = opts.keepHtml ? await fetchAndExtract(url, { keepHtml: true }) : await cachedFetchAndExtract(url);
  } catch {
    return undefined;
  }

  const text = (result.text ?? "").trim();
  // Below this a "page" is a cookie wall, a redirect stub or a JS shell. Citing
  // one would pass the resolution gate and support nothing.
  if (text.length < 120) return undefined;

  const id = `P${store.next++}`;
  const dir = pageDirFor(placeId);
  const extract = join(dir, `${id}.md`);
  const fetchedAt = new Date().toISOString();

  const header = [
    `# ${id} — ${result.title ?? url}`,
    "",
    `- url: ${result.finalUrl ?? url}`,
    `- role: ${role}`,
    `- fetched: ${fetchedAt}`,
    `- extractor: ${result.extractor ?? "native"}`,
    `- status: ${result.status ?? 200}`,
    "",
    "---",
    "",
  ].join("\n");

  // writeArtifact is atomic (tmp file + rename) but does not create the parent —
  // and the rename fails with ENOENT rather than with anything that names the
  // missing directory, so the mkdir belongs here, not in a caller's memory.
  if (!isNoWrite()) mkdirSync(join(runDir, dir), { recursive: true });
  writeArtifact(join(runDir, extract), header + text + markupEvidence(result.html) + "\n");

  return {
    record: {
      id,
      url: result.finalUrl ?? url,
      role,
      title: result.title,
      fetchedAt,
      extractor: result.extractor,
      status: result.status,
      chars: text.length,
      extract,
    },
    text,
    title: result.title,
    html: (result as { html?: string }).html,
  };
}

/**
 * Contacts that live in the MARKUP, appended to the stored extract.
 *
 * A `mailto:` href and a `tel:` link are not in a page's visible text, so text
 * extraction drops them — and then the citation gate, which re-opens the stored
 * file to confirm that everything attributed to `[P3]` is actually in `[P3]`,
 * correctly reported a real address as unfound. The gate was right and the
 * artifact was incomplete.
 *
 * The rule this restores is the important one: **the cited artifact carries its
 * own evidence**. Anything this tool claims to have read from a page must be
 * re-readable in the file that page was stored as — by the gate, and by a human
 * six weeks later who wants to know where an email came from. Loosening the
 * gate to trust in-memory extraction instead would have removed the only thing
 * standing between a prospect file and a fabricated address.
 */
function markupEvidence(html: string | undefined): string {
  if (!html) return "";
  const lines: string[] = [];
  const add = (label: string, value: string) => {
    const entry = `- ${label}: ${value}`;
    if (!lines.includes(entry)) lines.push(entry);
  };

  for (const m of html.matchAll(/mailto:([^"'?>\s]+@[^"'?>\s]+)/gi)) add("mailto", decodeURIComponent(m[1]!));
  for (const m of html.matchAll(/tel:([+0-9().\s-]{6,})/gi)) add("tel", m[1]!.trim());
  for (const m of html.matchAll(/https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?(?:facebook|instagram|linkedin|twitter|x|youtube|tiktok)\.com\/[^\s"'<>)]+/gi)) {
    add("social", m[0].replace(/[)"'<>]+$/, ""));
  }
  if (lines.length === 0) return "";

  return [
    "",
    "---",
    "",
    "## Contacts in the markup",
    "",
    "Read from this page's HTML rather than from its visible text — `mailto:` and",
    "`tel:` hrefs and social links. Recorded here so that anything attributed to",
    "this page can be re-read in this file, which is what the citation gate does.",
    "",
    ...lines,
  ].join("\n");
}

/** The polite identity, exported so callers that bypass fetchPage stay consistent. */
export { politeUa };
