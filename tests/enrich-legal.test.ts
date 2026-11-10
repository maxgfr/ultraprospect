// Which page tier 1 spends its one legal fetch on.
//
// Outside France the legal notice is where the register identity comes from at
// all: `confirm` reads the HRB or VAT number off it. So the page tier 1 reads
// has to be the NOTICE — not the privacy policy filed under the same role, and
// not a path guessed for another country's law.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "../src/types.js";

const requested: string[] = [];
/** path -> page text. Anything else answers 404. */
let site: Record<string, string> = {};
let homeLinks: string[] = [];

const page = (text: string) => `${text} `.repeat(12);

vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  fetchRobots: async () => undefined,
  fetchSitemap: async () => ({ urls: [] }),
  fetchAndExtract: async (url: string) => {
    requested.push(url);
    const path = new URL(url).pathname;
    const text = site[path];
    if (text === undefined) return { status: 404, text: "", html: "", finalUrl: url };
    const html = path === "/" ? homeLinks.map((href) => `<a href="${href}">link</a>`).join("") : "";
    return { status: 200, text: page(text), html, finalUrl: url };
  },
  isNoWrite: () => true,
  writeArtifact: () => {},
}));

const { isLegalNotice, legalGuessesFor, pickByRole, runEnrich } = await import("../src/enrich.js");
const { newPageStore } = await import("../src/pages.js");

function company(): Place {
  return {
    id: "osm:n1",
    name: "Beispiel Software",
    sources: ["osm"],
    address: {},
    website: { url: "https://beispiel.example/", confidence: "corroborated", evidence: ["P0"] },
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
  };
}

beforeEach(() => {
  requested.length = 0;
  site = {};
  homeLinks = [];
});

describe("pickByRole on the legal role", () => {
  it("takes the notice over the privacy policy, whichever was seen first", () => {
    const urls = ["https://x.de/datenschutz", "https://x.de/impressum", "https://x.de/agb"];
    expect(pickByRole(urls, ["legal"], "de").get("legal")).toBe("https://x.de/impressum");
    expect(pickByRole([...urls].reverse(), ["legal"], "de").get("legal")).toBe("https://x.de/impressum");
  });

  it("takes the notice in the run's own language over a translation of it", () => {
    const urls = ["https://x.com/es/aviso-legal/", "https://x.com/de/impressum/"];
    expect(pickByRole(urls, ["legal"], "de").get("legal")).toBe("https://x.com/de/impressum/");
    expect(pickByRole(urls, ["legal"], "es").get("legal")).toBe("https://x.com/es/aviso-legal/");
  });

  it("still settles for a privacy page when that is all the site links", () => {
    expect(pickByRole(["https://x.de/datenschutz"], ["legal"], "de").get("legal")).toBe("https://x.de/datenschutz");
  });

  it("knows a notice from the other pages filed as legal", () => {
    expect(isLegalNotice("https://x.de/impressum/")).toBe(true);
    expect(isLegalNotice("https://x.fr/mentions-legales")).toBe(true);
    expect(isLegalNotice("https://x.de/datenschutz")).toBe(false);
    expect(isLegalNotice("https://x.fr/cgv")).toBe(false);
  });
});

describe("legalGuessesFor", () => {
  it("puts the country's own path first and keeps the rest behind it", () => {
    expect(legalGuessesFor("de")[0]).toBe("/impressum");
    expect(legalGuessesFor("es")[0]).toBe("/aviso-legal");
    expect(legalGuessesFor("fr")[0]).toBe("/mentions-legales");
    expect(legalGuessesFor(undefined)[0]).toBe("/mentions-legales");
    expect(legalGuessesFor("de")).toContain("/mentions-legales");
  });
});

describe("tier 1 finds the legal notice a site does not link", () => {
  it("reaches /impressum on a German site, which the first guess in the list never did", async () => {
    site = { "/": "Beispiel Software baut Software.", "/impressum": "Impressum. Beispiel Software GmbH, HRB 12345, Amtsgericht Hamburg." };
    const place = company();
    await runEnrich(".", [place], newPageStore(), { tier: 1, countryCode: "de" });
    expect(requested).toContain("https://beispiel.example/impressum");
    expect(requested).not.toContain("https://beispiel.example/mentions-legales");
    expect(place.pages).toHaveLength(2);
  });

  it("keeps guessing past a miss, within a small budget", async () => {
    site = { "/": "Beispiel Software baut Software.", "/imprint": "Imprint. Beispiel Software GmbH, HRB 12345." };
    const place = company();
    await runEnrich(".", [place], newPageStore(), { tier: 1, countryCode: "de" });
    expect(requested.filter((u) => u !== "https://beispiel.example/")).toEqual([
      "https://beispiel.example/impressum",
      "https://beispiel.example/impressum/",
      "https://beispiel.example/imprint",
    ]);
    expect(place.pages).toHaveLength(2);
  });

  it("gives up after three misses rather than walking the whole list", async () => {
    site = { "/": "Beispiel Software baut Software." };
    const place = company();
    await runEnrich(".", [place], newPageStore(), { tier: 1, countryCode: "de" });
    expect(requested).toHaveLength(4);
    expect(place.pages).toHaveLength(1);
  });

  it("guesses the notice when all the site links is its privacy policy, and reads the notice instead", async () => {
    site = {
      "/": "Beispiel Software baut Software.",
      "/datenschutz": "Datenschutzerklärung.",
      "/impressum": "Impressum. Beispiel Software GmbH, HRB 12345.",
    };
    homeLinks = ["/datenschutz"];
    const place = company();
    await runEnrich(".", [place], newPageStore(), { tier: 1, countryCode: "de" });
    expect(requested).toContain("https://beispiel.example/impressum");
    expect(requested).not.toContain("https://beispiel.example/datenschutz");
  });

  it("does not guess at all when the site links its notice", async () => {
    site = { "/": "Beispiel Software baut Software.", "/impressum": "Impressum. Beispiel Software GmbH, HRB 12345." };
    homeLinks = ["/impressum"];
    const place = company();
    await runEnrich(".", [place], newPageStore(), { tier: 1, countryCode: "de" });
    expect(requested).toEqual(["https://beispiel.example/", "https://beispiel.example/impressum"]);
  });
});
