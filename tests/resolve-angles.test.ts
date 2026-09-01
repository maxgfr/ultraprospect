import { describe, expect, it } from "vitest";
import { DEFAULT_QUERIES_PER_PLACE, classifyHost, queriesFor } from "../src/resolve.js";
import type { Place } from "../src/types.js";
import { rec } from "./factories.js";

function place(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "Boulangerie Magali",
    sources: ["osm"],
    osm: { id: "n1", osmType: "node", osmId: 1, name: "Boulangerie Magali", lat: 48.84, lon: 2.42, tags: {} },
    address: {},
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
    ...over,
  };
}

describe("the street-address angle", () => {
  it("is spent when a street is known", () => {
    // The door number is a fact about this business that its own site, its
    // listing and its social page all tend to repeat.
    const p = place({ address: { numero: "117", libelleVoie: "Avenue de Paris", commune: "Saint-Mandé" } });
    expect(queriesFor(p, "Saint-Mandé", "fr")).toContain("Boulangerie Magali 117 Avenue de Paris Saint-Mandé");
  });

  it("works without a house number", () => {
    const p = place({ address: { libelleVoie: "Avenue de Paris", commune: "Saint-Mandé" } });
    expect(queriesFor(p, "Saint-Mandé", "fr")).toContain("Boulangerie Magali Avenue de Paris Saint-Mandé");
  });

  it("OUTRANKS the legal-notice angle, so a tight budget buys the address first", () => {
    // A bakery is not obliged to publish mentions légales and mostly does not.
    // Both angles survive when there is room — the budget is a ceiling, not a
    // target — but when it binds, the door number wins over the guess.
    const p = place({ address: { numero: "117", libelleVoie: "Avenue de Paris", commune: "Saint-Mandé" } });
    const q = queriesFor(p, "Saint-Mandé", "fr");
    const address = q.findIndex((x) => x.includes("Avenue de Paris"));
    const legal = q.findIndex((x) => x.includes("mentions"));
    expect(address).toBeGreaterThanOrEqual(0);
    expect(address).toBeLessThan(legal === -1 ? Number.POSITIVE_INFINITY : legal);

    expect(queriesFor(p, "Saint-Mandé", "fr", 2).some((x) => x.includes("Avenue de Paris"))).toBe(true);
    expect(queriesFor(p, "Saint-Mandé", "fr", 2).some((x) => x.includes("mentions"))).toBe(false);
  });

  it("still falls back to the legal notice when there is no street to spend", () => {
    // Germany, where the Impressum is the angle the whole thing was written for
    // — and where OSM nodes often carry no addr:street at all.
    const german = place({ name: "Bäckerei Siebert", address: { commune: "Berlin" } });
    german.osm!.name = "Bäckerei Siebert";
    expect(queriesFor(german, "Berlin", "de")).toContain("Bäckerei Siebert Impressum");
  });

  it("is not emitted at all when nothing knows the street", () => {
    const q = queriesFor(place({ address: { commune: "Saint-Mandé" } }), "Saint-Mandé", "fr");
    expect(q.every((x) => !x.includes("Avenue"))).toBe(true);
  });
});

describe("the per-place query budget", () => {
  const rich = () =>
    place({
      address: { numero: "117", libelleVoie: "Avenue de Paris", commune: "Saint-Mandé" },
      registry: rec({ id: "302474648", establishmentId: "30247464801175", legalName: "MAGALI SARL" }),
    });

  it("defaults to three, because the agent runs every one by hand", () => {
    expect(queriesFor(rich(), "Saint-Mandé", "fr")).toHaveLength(DEFAULT_QUERIES_PER_PLACE);
  });

  it("lets an aimed run afford more angles", () => {
    const q = queriesFor(rich(), "Saint-Mandé", "fr", 5);
    expect(q.length).toBeGreaterThan(DEFAULT_QUERIES_PER_PLACE);
    // The address angle is one of the ones a bigger budget buys.
    expect(q.some((x) => x.includes("Avenue de Paris"))).toBe(true);
  });

  it("lets a two-thousand-place sweep spend less", () => {
    expect(queriesFor(rich(), "Saint-Mandé", "fr", 1)).toHaveLength(1);
  });

  it("never returns nothing, however small the budget", () => {
    expect(queriesFor(rich(), "Saint-Mandé", "fr", 0).length).toBeGreaterThan(0);
  });

  it("keeps the registration number, the highest-precision angle there is", () => {
    expect(queriesFor(rich(), "Saint-Mandé", "fr", 8)).toContain('"30247464801175"');
  });
});

describe("the directories a live local search actually returns", () => {
  // Every host below outranked the business's own presence in a real
  // Saint-Mandé search, and every one of them carries the trading name AND the
  // street address — so the corroboration check accepts them on its two
  // strongest signals. Left unlisted, alentoor.fr and
  // boulangeries-patisseries.fr were both filed as a company's own website,
  // `corroborated`, in a real run.
  it.each([
    "https://www.alentoor.fr/saint-mande/restaurant/755408-le-paris-cafe",
    "https://www.boulangeries-patisseries.fr/boulangeries/94067-saint-mande/x.htm",
    "https://trouver-ouvert.fr/saint-mande/boulangerie-magali-2483966",
    "https://www.aleou.fr/traiteurs-seminaire/47330-boulangerie-magali.html",
    "https://eater.space/le-paris-cafe",
    "https://mapstr.com/place/4M0YIAaonF",
  ])("excludes %s", (url) => {
    expect(classifyHost(url, "fr")).toBe("directory");
  });

  it("still calls an independent trader's own domain its own", () => {
    expect(classifyHost("https://boulangerie-magali.fr/", "fr")).toBe("own");
  });

  it("keeps a Facebook page as social, not as a website", () => {
    // For a local trader this is very often the ENTIRE web presence. It belongs
    // in contacts.socials, and the place is `social-only`, not `none`.
    expect(classifyHost("https://www.facebook.com/boulangeriemagali/", "fr")).toBe("social");
  });
});
