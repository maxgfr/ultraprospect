import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectQuotes, quoteKey } from "../src/excerpts.js";
import { buildHtml } from "../src/render.js";
import type { Place, RunManifest } from "../src/types.js";

function place(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "No Limit",
    sources: ["osm"],
    address: {},
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
    ...over,
  };
}

function manifest(): RunManifest {
  return {
    version: 1,
    tool: "ultraprospect",
    toolVersion: "1.0.0",
    builtAt: "2026-08-10T00:00:00.000Z",
    slug: "Hamburg",
    target: { query: "Hamburg", label: "Hamburg, Deutschland", lat: 53.5, lon: 10, bbox: [53.4, 53.7, 9.7, 10.3], source: "nominatim" },
    filters: {},
    lanes: [],
    counts: {
      osm: 0,
      registry: 0,
      byConnector: {},
      places: 0,
      merged: 0,
      undecided: 0,
      withWebsite: 0,
      enrichedTier1: 0,
      enrichedTier2: 0,
      confirmed: 0,
      dossiers: 0,
    },
    truncated: false,
    notes: [],
    licences: [],
    timings: {},
  };
}

/** A run directory holding one page extract, in the shape pages.ts writes. */
function runWithPage(placeId: string, pageId: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ultraprospect-quotes-"));
  const pages = join(dir, "pages", placeId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  mkdirSync(pages, { recursive: true });
  writeFileSync(
    join(pages, `${pageId}.md`),
    `# ${pageId} — Karriere\n\n- url: https://nolimit-it.de/karriere/\n- role: careers\n- fetched: 2026-08-21T20:04:03.389Z\n- extractor: native\n- status: 200\n\n---\n${body}\n`,
  );
  return dir;
}

const LONG = "x".repeat(400);

describe("collectQuotes", () => {
  it("cuts the passage around the cited value, with the page's own provenance", () => {
    const dir = runWithPage("osm:n1", "P7", `${LONG} Ob als Werkstudent, auf Honorarbasis oder im festen Anstellungsverhältnis ${LONG}`);
    const p = place({ signals: signalsWith([{ value: "Honorarbasis", from: "P7", lane: "web" }]), pages: ["P7"] });
    const quote = collectQuotes(dir, [p]).get(quoteKey("osm:n1", "P7", "Honorarbasis"))!;

    expect(quote.located).toBe(true);
    expect(quote.text).toContain("auf Honorarbasis oder im festen");
    // The provenance header is the reason a page read six weeks ago can be dated.
    expect(quote.url).toBe("https://nolimit-it.de/karriere/");
    expect(quote.role).toBe("careers");
    expect(quote.fetchedAt).toBe("2026-08-21T20:04:03.389Z");
    // Cut on both sides, and said so.
    expect(quote.text.startsWith("…")).toBe(true);
    expect(quote.text.endsWith("…")).toBe(true);
  });

  it("finds a phone published in a different shape from the one we stored", () => {
    // Stored normalised (+49402294990), published spaced (040 8787 8655). A
    // literal search would report every phone in a run as unlocatable.
    const dir = runWithPage("osm:n1", "P7", "Kontakt: Telefon 040 8787 8655, E-Mail info@nolimit-it.de");
    const p = place({ contacts: { emails: [], phones: [{ value: "+4940 87878655", from: "P7", lane: "web" }], socials: [], people: [] }, pages: ["P7"] });
    const quote = collectQuotes(dir, [p]).get(quoteKey("osm:n1", "P7", "+4940 87878655"))!;
    expect(quote.located).toBe(true);
    expect(quote.text).toContain("040 8787 8655");
  });

  it("says a value is not in the page rather than showing the top of it as if it were", () => {
    // A confident-looking excerpt that does not contain the thing it is evidence
    // for is worse than no excerpt: it invites a reader to stop checking.
    const dir = runWithPage("osm:n1", "P7", "Nothing relevant on this page at all.");
    const p = place({ contacts: { emails: [{ value: "ghost@nolimit-it.de", from: "P7", lane: "web" }], phones: [], socials: [], people: [] }, pages: ["P7"] });
    const quote = collectQuotes(dir, [p]).get(quoteKey("osm:n1", "P7", "ghost@nolimit-it.de"))!;
    expect(quote.located).toBe(false);
    expect(quote.text).toContain("does not appear in the stored extract");
    expect(quote.text).not.toContain("Nothing relevant on this page");
  });

  it("produces no quote for a page id with no file behind it", () => {
    // An id with nothing behind it must never render as evidence.
    const dir = runWithPage("osm:n1", "P7", "here");
    const p = place({ contacts: { emails: [{ value: "a@b.de", from: "P99", lane: "web" }], phones: [], socials: [], people: [] }, pages: ["P99"] });
    expect(collectQuotes(dir, [p]).size).toBe(0);
  });

  it("puts the passage in the page, behind a disclosure that needs no JavaScript", () => {
    const dir = runWithPage("osm:n1", "P7", `${LONG} auf Honorarbasis oder im festen ${LONG}`);
    const p = place({ signals: signalsWith([{ value: "Honorarbasis", from: "P7", lane: "web" }]), pages: ["P7"] });
    const html = buildHtml([p], manifest(), { quotes: collectQuotes(dir, [p]) });

    expect(html).toContain('<details class="q"><summary>[P7]</summary>');
    expect(html).toContain("auf Honorarbasis oder im festen");
    expect(html).toContain("fetched 2026-08-21");
    // And the page still reaches nobody when it loads.
    expect(html).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource|\bimport\s*\(/i);
  });

  it("falls back to the bare id when no passage was collected", () => {
    const p = place({ contacts: { emails: [{ value: "a@b.de", from: "P7", lane: "web" }], phones: [], socials: [], people: [] } });
    const html = buildHtml([p], manifest());
    expect(html).toContain('<span class="src">[P7]</span>');
    expect(html).not.toContain('<details class="q">');
  });
});

function signalsWith(termMentions: { value: string; from: string; lane: "web" }[]) {
  return {
    hasWebsite: true,
    pageCount: 1,
    openRoles: 0,
    termMentions,
    termLexicon: ["honorarbasis"],
    atsProviders: [],
    analytics: [],
    techStack: [],
    hasPricingPage: false,
    hasEcommerce: false,
    languages: [],
    socialProfiles: [],
  };
}
