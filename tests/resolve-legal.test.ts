// When a home page does not corroborate, resolve reads ONE legal notice.
//
// On a German run 14 of 62 sites stayed unverified: the home page carries
// neither the street nor a distinctive name token ("VTG" is too short to
// count), while the Impressum the law requires carries both.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "../src/types.js";
import { rec } from "./factories.js";

const requested: string[] = [];
/** path -> page text. Anything else answers 404. */
let site: Record<string, string> = {};
let homeLinks: string[] = [];
let disallowed: string[] = [];
/** Where a non-home page claims to have landed, when set. */
let redirectTo: string | undefined;

const page = (text: string) => `${text} `.repeat(12);

vi.mock("../src/engine.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/engine.js")>();
  const answer = async (url: string) => {
    requested.push(url);
    const path = new URL(url).pathname;
    const text = site[path];
    if (text === undefined) return { status: 404, text: "", html: "", finalUrl: url };
    const html = path === "/" ? homeLinks.map((href) => `<a href="${href}">link</a>`).join("") : "";
    return { status: 200, text: page(text), html, finalUrl: path !== "/" && redirectTo ? redirectTo : url };
  };
  return {
    ...real,
    fetchRobots: async () => (disallowed.length ? { disallowed } : undefined),
    isAllowed: (robots: { disallowed: string[] }, url: string) => !robots.disallowed.includes(new URL(url).pathname),
    fetchAndExtract: answer,
    cachedFetchAndExtract: answer,
    isNoWrite: () => true,
    writeArtifact: () => {},
  };
});

const { runResolve } = await import("../src/resolve.js");
const { newPageStore } = await import("../src/pages.js");

function company(): Place {
  return {
    id: "de-hr:1",
    name: "VTG GmbH",
    sources: ["registry"],
    registry: rec({ connectorId: "de-handelsregister", id: "HRB 98765", establishmentId: undefined, legalName: "VTG GmbH" }),
    address: { libelleVoie: "Nagelsweg", codePostal: "20097", commune: "Hamburg" },
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
  };
}

const HOME = "Welcome to VTG — rail logistics across Europe, wagons and tank containers.";
const IMPRESSUM = "Impressum. VTG GmbH, Nagelsweg 34, 20097 Hamburg. Registergericht Hamburg HRB 98765.";

const resolveOne = async (p: Place, countryCode = "de") =>
  runResolve("/run", [p], newPageStore(), { countryCode, webResults: [{ placeId: p.id, url: "https://vtg.example/" }] });

beforeEach(() => {
  requested.length = 0;
  site = { "/": HOME };
  homeLinks = [];
  disallowed = [];
  redirectTo = undefined;
});

describe("resolve reads the legal notice when the home page does not corroborate", () => {
  it("corroborates on the notice the home page links to, and cites both pages", async () => {
    site["/rechtliches/impressum"] = IMPRESSUM;
    homeLinks = ["/datenschutz", "/rechtliches/impressum"];
    const p = company();
    await resolveOne(p);
    expect(requested).toEqual(["https://vtg.example/", "https://vtg.example/rechtliches/impressum"]);
    expect(p.website?.confidence).toBe("corroborated");
    expect(p.website?.evidence.slice(0, 2)).toEqual(["P1", "P2"]);
    expect(p.website?.evidence.join(" ")).toMatch(/address "Nagelsweg 20097" on the legal notice P2/);
    expect(p.pages).toEqual(["P1", "P2"]);
  });

  it("guesses the path the run's country spells it at when no notice is linked", async () => {
    site["/impressum"] = IMPRESSUM;
    const p = company();
    await resolveOne(p);
    expect(requested).toEqual(["https://vtg.example/", "https://vtg.example/impressum"]);
    expect(p.website?.confidence).toBe("corroborated");
  });

  it("honours robots.txt for the notice", async () => {
    site["/impressum"] = IMPRESSUM;
    disallowed = ["/impressum"];
    const p = company();
    await resolveOne(p);
    expect(requested).toEqual(["https://vtg.example/"]);
    expect(p.website?.confidence).toBe("unverified");
  });

  it("spends no request guessing where the country has no notice path of its own", async () => {
    const p = company();
    await resolveOne(p, "us");
    expect(requested).toEqual(["https://vtg.example/"]);
  });

  it("does not corroborate on a notice that redirected to another site", async () => {
    site["/impressum"] = IMPRESSUM;
    redirectTo = "https://parent-group.example/impressum";
    const p = company();
    await resolveOne(p);
    expect(p.website?.confidence).toBe("unverified");
  });

  it("reads one notice per place, not one per failed candidate", async () => {
    const p = company();
    await runResolve("/run", [p], newPageStore(), {
      countryCode: "de",
      webResults: [
        { placeId: p.id, url: "https://vtg.example/" },
        { placeId: p.id, url: "https://vtg-two.example/" },
      ],
    });
    expect(requested.filter((u) => u.endsWith("/impressum"))).toHaveLength(1);
  });
});
