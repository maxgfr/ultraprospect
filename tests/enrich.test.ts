import { describe, expect, it, vi } from "vitest";
import type { Place } from "../src/types.js";

vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  fetchRobots: async () => undefined,
  fetchSitemap: async () => ({ urls: [] }),
  fetchAndExtract: async () => ({
    status: 200,
    text: "Acme publishes this contact page for customers. ".repeat(4),
    html: '<a href="mailto:hello@example.com">Email us</a><a href="tel:+33143283007">Call us</a><a href="https://instagram.com/acme">Follow us</a>',
    finalUrl: "https://example.com/",
  }),
  isNoWrite: () => true,
  writeArtifact: () => {},
}));

const { runEnrich } = await import("../src/enrich.js");
const { newPageStore } = await import("../src/pages.js");

describe("contact provenance precedence", () => {
  it("keeps a fetched page citation when OSM declared the same contact", async () => {
    const place: Place = {
      id: "osm:n1",
      name: "Acme",
      sources: ["osm"],
      address: {},
      website: { url: "https://example.com/", confidence: "corroborated", evidence: ["P0"] },
      contacts: {
        emails: [{ value: "hello@example.com", from: "osm:n1", lane: "osm" }],
        phones: [{ value: "+33143283007", from: "osm:n1", lane: "osm" }],
        socials: [{ value: "https://instagram.com/acme", from: "osm:n1", lane: "osm" }],
        people: [],
      },
      jobs: [],
      pages: [],
    };

    await runEnrich(".", [place], newPageStore(), { tier: 1 });

    expect(place.contacts.emails).toEqual([{ value: "hello@example.com", from: "P1", lane: "web", note: "mailto link" }]);
    expect(place.contacts.phones).toEqual([{ value: "+33143283007", from: "P1", lane: "web", note: "tel: link" }]);
    expect(place.contacts.socials).toEqual([{ value: "https://instagram.com/acme", from: "P1", lane: "web", note: "instagram.com link" }]);
  });
});
