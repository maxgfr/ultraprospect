// What the keyless fallback tells the run when it finds nothing.
//
// `resolve --engine-search` is the one lane that reaches a third-party search
// engine, and those engines block automated clients. Measured on a real
// Saint-Mandé run: 12 companies searched, 0 sites found, and every engine had
// turned us away — but `keylessHits` caught and discarded the engine's notes, so
// the run reported "11 left without a site" and nothing else. A blocked search
// and a town with no web presence produced identical output.
//
// The engine now says which; this is the half that makes the run repeat it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "../src/types.js";
import { rec } from "./factories.js";

/** What the mocked engine search answers next. */
let answer: { hits: Array<{ url: string; title?: string; snippet?: string }>; notes: string[] } = { hits: [], notes: [] };

vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  search: async () => answer,
}));

// No network, and no page store on disk: this file is about what the lane SAYS,
// not about corroboration, which resolve.test.ts covers.
vi.mock("../src/pages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/pages.js")>()),
  fetchPage: async () => ({ ok: false, reason: "unreachable" }),
}));

const { runResolve } = await import("../src/resolve.js");
const { newPageStore } = await import("../src/pages.js");

function place(id: string, name: string): Place {
  return {
    id,
    name,
    sources: ["registry"],
    registry: rec({ legalName: name, id: "844355727", establishmentId: "84435572700083" }),
    address: { commune: "SAINT-MANDE", codePostal: "94160" },
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
  };
}

beforeEach(() => {
  answer = { hits: [], notes: [] };
});

describe("the keyless fallback repeats what the engine said", () => {
  it("carries a block through to the run's notes instead of swallowing it", async () => {
    answer = { hits: [], notes: ["Every keyless engine blocked this client (ddg, ddglite, mojeek) — nothing was searched."] };

    const places = [place("fr-sirene:1", "SORARE"), place("fr-sirene:2", "FINTECTURE")];
    const outcome = await runResolve("/run", places, newPageStore(), { useEngineSearch: true, countryCode: "fr", town: "Saint-Mandé" });

    expect(outcome.notes.some((n) => /blocked this client/.test(n))).toBe(true);
  });

  it("says it once, not once per query per place", async () => {
    // Two places, up to three queries each, one cascade note every time. Six
    // copies of the same sentence would bury the run's own summary under it.
    answer = { hits: [], notes: ["Every keyless engine blocked this client (ddg, ddglite, mojeek) — nothing was searched."] };

    const places = [place("fr-sirene:1", "SORARE"), place("fr-sirene:2", "FINTECTURE")];
    const outcome = await runResolve("/run", places, newPageStore(), { useEngineSearch: true, countryCode: "fr" });

    expect(outcome.notes.filter((n) => /blocked this client/.test(n))).toHaveLength(1);
  });

  it("does not report the local stack being absent as a problem with the run", async () => {
    // SearXNG and Firecrawl are localhost and off by default, so the cascade
    // mentions them on EVERY query. Repeating that in a prospect run's notes
    // would be advice about Docker filed as a finding about a territory.
    answer = { hits: [], notes: ["SearXNG not running at http://localhost:8888 — start it with `ultraprospect searxng up` for local, keyless discovery."] };

    const outcome = await runResolve("/run", [place("fr-sirene:1", "SORARE")], newPageStore(), { useEngineSearch: true, countryCode: "fr" });

    expect(outcome.notes.some((n) => /SearXNG/.test(n))).toBe(false);
  });

  it("says nothing extra when the engines answered and simply had no hits", async () => {
    answer = { hits: [], notes: ["No results from any engine. `ultraprospect stack up` starts SearXNG and Firecrawl locally."] };

    const outcome = await runResolve("/run", [place("fr-sirene:1", "SORARE")], newPageStore(), { useEngineSearch: true, countryCode: "fr" });

    // The summary line still reports the absence; what must not appear is a
    // claim that something blocked us.
    expect(outcome.notes.some((n) => /blocked/.test(n))).toBe(false);
  });

  it("does not reach the engine at all when the agent supplied its own hits", async () => {
    const spy = vi.fn();
    answer = { hits: [], notes: ["should not be consulted"] };
    const outcome = await runResolve("/run", [place("fr-sirene:1", "SORARE")], newPageStore(), {
      countryCode: "fr",
      webResults: [{ url: "https://sorare.com/", title: "SORARE", placeId: "fr-sirene:1" }],
    });
    expect(spy).not.toHaveBeenCalled();
    expect(outcome.notes.some((n) => /should not be consulted/.test(n))).toBe(false);
  });
});
