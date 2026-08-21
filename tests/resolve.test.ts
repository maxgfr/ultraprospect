import { describe, expect, it } from "vitest";
import { classifyHost, corroborate, groupHits, needsResolving, queriesFor, searchLocaleFor } from "../src/resolve.js";
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
    expect(classifyHost("https://lesofficiers.fr/", "fr")).toBe("own");
  });

  it("excludes each country's own directories, which a French-only list never did", () => {
    // A Berlin sweep would otherwise have enriched from gelbeseiten.de and
    // produced a dossier about a phone book.
    expect(classifyHost("https://www.gelbeseiten.de/gsbiz/123", "de")).toBe("directory");
    expect(classifyHost("https://www.paginasamarillas.es/x", "es")).toBe("directory");
    expect(classifyHost("https://www.yell.com/biz/x", "gb")).toBe("directory");
    expect(classifyHost("https://www.yellowpages.com/x", "us")).toBe("directory");
  });

  it("excludes the international directories in every country", () => {
    for (const cc of ["fr", "de", "us", undefined]) {
      expect(classifyHost("https://www.tripadvisor.com/Restaurant_Review-x", cc), String(cc)).toBe("directory");
      expect(classifyHost("https://www.yelp.com/biz/x", cc), String(cc)).toBe("directory");
    }
  });

  it("excludes directories, which corroborate beautifully and are not the company", () => {
    // A pagesjaunes listing carries the name, the address AND the phone number,
    // so the evidence check would happily accept it. It has to be excluded by
    // host, or the enrichment stage writes a dossier about a directory page.
    //
    // National directories are only excluded for their own country now: the
    // list was ~90% French and silently stopped filtering anything the moment a
    // run left France.
    expect(classifyHost("https://www.pagesjaunes.fr/pros/12345", "fr")).toBe("directory");
    expect(classifyHost("https://www.societe.com/societe/x-123.html", "fr")).toBe("directory");
    expect(classifyHost("https://annuaire-entreprises.data.gouv.fr/entreprise/x", "fr")).toBe("directory");
    expect(classifyHost("https://www.doctolib.fr/dentiste/paris/x", "fr")).toBe("directory");
    // …and NOT excluded outside France, where the host is not a directory for
    // the territory being swept.
    expect(classifyHost("https://www.doctolib.fr/dentiste/paris/x", "de")).toBe("own");
  });

  it("excludes the French company-record directories a real French search actually returns", () => {
    // Harvested from live searches over a Saint-Mandé sweep: every one of these
    // ranked at or above the company's own domain for queries built out of the
    // company name, the town and the SIREN.
    //
    // They are the dangerous shape rather than merely the useless one. A phone
    // book carries a name and an address; these carry the SIREN — so
    // `corroborate` accepts them on the strongest signal it has, and the run
    // records a register directory as the company's own website, CORROBORATED.
    // Excluding by host is the only thing that stops it.
    for (const url of [
      "https://actulegales.fr/recherche/siren/848367397",
      "https://data.inpi.fr/entreprises/532821089",
      "https://rubypayeur.com/societe/studiomatic-848367397",
      "https://societeinfo.com/app/recherche/societe/443452503",
      "https://repreneurs.com/814417424-kinequantum",
      "https://infonet.fr/entreprises/84435572700026-sorare/",
      "https://datalegal.fr/entreprises/443452503/",
      "https://www.annuaire-inverse-france.com/0143659042/atixnet",
      "https://www.business-directory.fr/sites/ubisoft-france-siege-social-adresse-et-contact/",
      "https://www.compteo.fr/expert-comptable/soexpertise-21605",
      "https://annuaire.petitesaffiches.fr/traiteur/baxterstorey-france-s-a-s-53282108900069/",
      "https://www.maitredata.com/app/accords-entreprise/baxterstorey-france-sas/239141",
      "https://www.droits-salaries.com/532821089-/53282108900010-/x.shtml",
      "https://afjv.com/societe/1410-sorare.htm",
      "https://annuaire.experts-comptables.org/expert-comptable/17702-so-expertise-saint-mande-94160",
    ]) {
      expect(classifyHost(url, "fr"), url).toBe("directory");
    }
  });

  it("still calls those hosts a company's own outside France", () => {
    // The national lists are added for the territory being swept, and adding a
    // French register directory to every run would filter a real domain
    // somewhere else that merely shares a name.
    expect(classifyHost("https://data.inpi.fr/entreprises/532821089", "de")).toBe("own");
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

  it("refuses an address the run itself shows is shared by several companies", () => {
    // "Two businesses can share a name; they do not share a doorway" is false
    // often enough to matter. Measured on a live Saint-Mandé sweep: 62 of 86
    // companies sat at an address occupied by at least one other company in the
    // same run — 36 of them at one business centre. At 2 avenue Pasteur the CNRS,
    // BaxterStorey and three Ubisoft entities share a door, and Ubisoft's own
    // page duly corroborated as the CNRS's website.
    //
    // Nothing is assumed here: sharing is READ OFF the run, so the signal is
    // dropped exactly where it has been shown not to distinguish.
    const shared = new Set(["2|PASTEUR|94160"]);
    const p = place({
      osm: undefined,
      name: "CNRS",
      registry: rec({ legalName: "CNRS" }),
      address: { numero: "2", libelleVoie: "PASTEUR", codePostal: "94160" },
    });
    const r = corroborate(p, "Ubisoft Worldwide HQ — 2 avenue Pasteur, 94160 Saint-Mandé", "Ubisoft", shared);
    expect(r.ok).toBe(false);
    expect(r.evidence).toHaveLength(0);
  });

  it("still accepts the address when this run shows it belongs to one company", () => {
    const p = place({ osm: undefined, name: "x", address: { numero: "12", libelleVoie: "Avenue de Nogent", codePostal: "94300" } });
    const r = corroborate(p, "Retrouvez-nous 12 Avenue de Nogent, 94300 Vincennes", undefined, new Set(["2|PASTEUR|94160"]));
    expect(r.ok).toBe(true);
  });

  it("keeps a registration number as evidence even at a shared address", () => {
    // Sharing a door says nothing about a registration number, which no other
    // company carries. Dropping that too would throw away the strongest signal
    // there is at exactly the addresses where it is most needed.
    const shared = new Set(["14|DU GENERAL DE GAULLE|94160"]);
    const p = place({
      osm: undefined,
      name: "GEDIVOTE",
      registry: rec({ id: "851901165", legalName: "GEDIVOTE" }),
      address: { numero: "14", libelleVoie: "DU GENERAL DE GAULLE", codePostal: "94160" },
    });
    const r = corroborate(p, "RCS Créteil 851 901 165 — 14 avenue du Général de Gaulle, 94160 Saint-Mandé", "Gedivote", shared);
    expect(r.ok).toBe(true);
    expect(r.evidence.some((e) => e.includes("851901165"))).toBe(true);
    expect(r.evidence.some((e) => e.includes("address"))).toBe(false);
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

  it("matches a name token as a WORD, not as a substring of a longer one", () => {
    // Measured on a live Saint-Mandé run: the CNRS was handed Ubisoft's careers
    // page, because "national" — a distinctive token of CENTRE NATIONAL DE LA
    // RECHERCHE SCIENTIFIQUE — is a substring of "UBISOFT INTERNATIONAL". The
    // page then corroborated on a shared street address and the CNRS's website
    // became ubisoft.com.
    const cnrs = place({
      id: "cnrs",
      name: "CENTRE NATIONAL DE LA RECHERCHE SCIENTIFIQUE",
      osm: undefined,
      registry: rec({ legalName: "CENTRE NATIONAL DE LA RECHERCHE SCIENTIFIQUE" }),
    });
    const grouped = groupHits(
      [cnrs],
      [{ url: "https://www.ubisoft.com/fr-fr/company/careers", title: "Ubisoft Worldwide HQ", snippet: "UBISOFT INTERNATIONAL" }],
    );
    expect([...grouped.values()].flat()).toHaveLength(0);
  });

  it("does not read a URL's PATH as evidence of whose page it is", () => {
    // The same run: `actulegales.fr/recherche/siren/848367397` was handed to the
    // CNRS because the path segment "recherche" is one of its name tokens. A
    // path is the site's own vocabulary, not the company's.
    const cnrs = place({
      id: "cnrs",
      name: "CENTRE NATIONAL DE LA RECHERCHE SCIENTIFIQUE",
      osm: undefined,
      registry: rec({ legalName: "CENTRE NATIONAL DE LA RECHERCHE SCIENTIFIQUE" }),
    });
    const grouped = groupHits([cnrs], [{ url: "https://actulegales.fr/recherche/siren/848367397", title: "STUDIOMATIC, 94160 ST MANDE" }]);
    expect([...grouped.values()].flat()).toHaveLength(0);
  });

  it("still matches a name run together in a domain, which is how domains are spelled", () => {
    // The word rule must not cost the commonest true positive there is: a
    // company's own domain concatenates its name. So the host is still matched
    // as a substring — it is the one part of a URL that identifies an owner.
    const mt = place({ id: "mt", name: "MATCH TUNE", osm: undefined, registry: rec({ legalName: "MATCH TUNE" }) });
    const grouped = groupHits([mt], [{ url: "https://www.matchtune.com/", title: "AI Music Audit & Compliance" }]);
    expect(grouped.get("mt")).toHaveLength(1);
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

describe("searchLocaleFor", () => {
  it("searches in the territory's language, not the machine's", () => {
    // A run over Kreuzberg asking a search engine in American English gets an
    // American engine's idea of a Berlin bakery, and the company's own
    // German-language site is nowhere on the first page.
    expect(searchLocaleFor("de")).toBe("de-DE");
    expect(searchLocaleFor("fr")).toBe("fr-FR");
    expect(searchLocaleFor("gb")).toBe("en-GB");
    expect(searchLocaleFor("us")).toBe("en-US");
  });

  it("lets --lang override the country", () => {
    expect(searchLocaleFor("de", "en-GB")).toBe("en-GB");
  });

  it("says nothing rather than guessing for a country it has no locale for", () => {
    expect(searchLocaleFor("jp")).toBeUndefined();
    expect(searchLocaleFor(undefined)).toBeUndefined();
  });
});

describe("queriesFor, per country", () => {
  function german(): Place {
    return place({
      id: "osm:n9",
      name: "Bäckerei Siebert",
      osm: { id: "n9", osmType: "node", osmId: 9, name: "Bäckerei Siebert", lat: 52.53, lon: 13.42, tags: {} },
      address: { commune: "Berlin" },
      registry: undefined,
    });
  }

  it("adds the legal-notice angle in the territory's language when no registration number exists", () => {
    // Outside France there is no swept register, so no number to quote. The
    // page the law makes mandatory is the strongest angle left: only a
    // company's own site has an Impressum for that company.
    expect(queriesFor(german(), "Berlin", "de")).toContain("Bäckerei Siebert Impressum");
    expect(queriesFor(german(), "Madrid", "es")).toContain("Bäckerei Siebert aviso legal");
  });

  it("prefers the registration number when there is one, and drops the legal-notice angle", () => {
    const french = place({ registry: rec({ id: "302474648", establishmentId: "30247464801175" }) });
    const queries = queriesFor(french, "Vincennes", "fr");
    expect(queries).toContain('"30247464801175"');
    expect(queries.some((q) => q.includes("mentions"))).toBe(false);
  });

  it("adds nothing for a country with no modelled legal-notice obligation", () => {
    expect(queriesFor(german(), "Tokyo", "jp").some((q) => q.includes("Impressum"))).toBe(false);
  });
});
