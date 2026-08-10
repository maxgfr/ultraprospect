import { describe, expect, it } from "vitest";
import { classifyHost, corroborate, groupHits, needsResolving, queriesFor } from "../src/resolve.js";
import type { Place } from "../src/types.js";
import { rec } from "./factories.js";

function place(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "Les Officiers",
    sources: ["osm"],
    osm: { id: "n1", osmType: "node", osmId: 1, name: "Les Officiers", lat: 48.84, lon: 2.43, tags: {} },
    address: { libelleVoie: "Avenue de Nogent", codePostal: "94300", commune: "VINCENNES" },
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
    ...over,
  };
}

describe("classifyHost", () => {
  it("calls a company domain its own", () => {
    expect(classifyHost("https://lesofficiers.fr/")).toBe("own");
  });

  it("excludes directories, which corroborate beautifully and are not the company", () => {
    // A pagesjaunes listing carries the name, the address AND the phone number,
    // so the evidence check would happily accept it. It has to be excluded by
    // host, or the enrichment stage writes a dossier about a directory page.
    expect(classifyHost("https://www.pagesjaunes.fr/pros/12345")).toBe("directory");
    expect(classifyHost("https://www.societe.com/societe/x-123.html")).toBe("directory");
    expect(classifyHost("https://annuaire-entreprises.data.gouv.fr/entreprise/x")).toBe("directory");
    expect(classifyHost("https://www.doctolib.fr/dentiste/paris/x")).toBe("directory");
  });

  it("separates social profiles rather than discarding them", () => {
    // For a small trader a Facebook page is often the only web presence there
    // is. It belongs in contacts.socials, not in website.
    expect(classifyHost("https://www.facebook.com/lesofficiers")).toBe("social");
    expect(classifyHost("https://www.linkedin.com/company/x")).toBe("social");
  });

  it("treats an unparseable URL as unusable", () => {
    expect(classifyHost("not a url")).toBe("directory");
  });
});

describe("corroborate", () => {
  it("accepts a page carrying the SIREN", () => {
    const p = place({ registry: rec({ id: "302474648" }) });
    const r = corroborate(p, "Mentions légales — SIREN 302 474 648 — tous droits réservés");
    expect(r.ok).toBe(true);
    expect(r.evidence[0]).toContain("302474648");
  });

  it("accepts a page carrying the street and postcode", () => {
    const r = corroborate(place({ osm: undefined, name: "x" }), "Retrouvez-nous 12 Avenue de Nogent, 94300 Vincennes");
    expect(r.ok).toBe(true);
    expect(r.evidence.some((e) => e.includes("Avenue de Nogent"))).toBe(true);
  });

  it("accepts a page carrying the distinctive part of the name", () => {
    const r = corroborate(place(), "Bienvenue au restaurant Les Officiers, cuisine de saison");
    expect(r.ok).toBe(true);
  });

  it("REJECTS a page that carries nothing tying it to the company", () => {
    // The whole point: a search engine's first result is a claim about word
    // matching, not evidence about ownership.
    const r = corroborate(place(), "Bienvenue sur le site de la Boulangerie Martin à Lyon.");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("neither the company's name");
  });

  it("does not accept a generic word as a name match", () => {
    // "Pharmacie" on a page called Pharmacie du Centre proves nothing. Only
    // tokens of four characters or more count, and all of them must appear.
    const p = place({
      name: "Pharmacie Morssi",
      osm: { id: "n1", osmType: "node", osmId: 1, name: "Pharmacie Morssi", lat: 0, lon: 0, tags: {} },
      address: {},
    });
    const r = corroborate(p, "Pharmacie du Centre, votre pharmacie de garde à Lyon");
    expect(r.ok).toBe(false);
  });

  it("looks in the title as well as the body", () => {
    const r = corroborate(place(), "some unrelated body text entirely", "Les Officiers — restaurant");
    expect(r.ok).toBe(true);
  });

  it("ignores accents and spacing in a SIREN", () => {
    const p = place({ registry: rec({ id: "794598813" }) });
    expect(corroborate(p, "RCS Paris 794.598.813").ok).toBe(true);
  });
});

describe("queriesFor", () => {
  it("pairs each known name with the town", () => {
    const p = place({ registry: rec({ id: "1", legalName: "AUX BARREZIENS", tradingNames: ["L'AVENUE"] }) });
    const q = queriesFor(p);
    expect(q).toContain("Les Officiers VINCENNES");
    expect(q.some((x) => x.includes("AVENUE"))).toBe(true);
  });

  it("includes the SIREN as its own query — the highest-precision one there is", () => {
    const p = place({ registry: rec({ id: "302474648" }) });
    expect(queriesFor(p).some((q) => q.includes("302474648"))).toBe(true);
  });

  it("caps the number of queries so a large run stays affordable", () => {
    expect(queriesFor(place()).length).toBeLessThanOrEqual(3);
  });
});

describe("groupHits", () => {
  const a = place({ id: "a", name: "Les Officiers" });
  const b = place({
    id: "b",
    name: "Naturalia",
    osm: { id: "n2", osmType: "node", osmId: 2, name: "Naturalia", lat: 0, lon: 0, tags: {} },
  });

  it("honours an explicit placeId when the agent kept the hits grouped", () => {
    const grouped = groupHits([a, b], [{ url: "https://x.example", placeId: "b" }]);
    expect(grouped.get("b")).toHaveLength(1);
    expect(grouped.has("a")).toBe(false);
  });

  it("attributes an untagged pool by distinctive name tokens", () => {
    const grouped = groupHits(
      [a, b],
      [
        { url: "https://lesofficiers.fr", title: "Les Officiers" },
        { url: "https://naturalia.fr", title: "Naturalia, bio depuis 1973" },
      ],
    );
    expect(grouped.get("a")?.[0]?.url).toBe("https://lesofficiers.fr");
    expect(grouped.get("b")?.[0]?.url).toBe("https://naturalia.fr");
  });

  it("drops a hit that matches nothing rather than assigning it to the nearest guess", () => {
    const grouped = groupHits([a, b], [{ url: "https://unrelated.example", title: "Something else" }]);
    expect([...grouped.values()].flat()).toHaveLength(0);
  });
});

describe("needsResolving", () => {
  it("includes places with no website and those with only a mapper's claim", () => {
    const none = place({ id: "1" });
    const declared = place({ id: "2", website: { url: "https://x", confidence: "declared", evidence: ["osm"] } });
    const proven = place({ id: "3", website: { url: "https://y", confidence: "corroborated", evidence: ["P1"] } });
    expect(needsResolving([none, declared, proven]).map((p) => p.id)).toEqual(["1", "2"]);
  });
});
