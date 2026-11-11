// A URL the guard refuses is reported as a refusal, never as "unreachable".
import { describe, expect, it, vi } from "vitest";

const fetched: string[] = [];
vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  cachedFetchAndExtract: async (url: string) => {
    fetched.push(url);
    return { status: 200, text: "x".repeat(500), finalUrl: url };
  },
  fetchAndExtract: async (url: string) => {
    fetched.push(url);
    return { status: 200, text: "x".repeat(500), finalUrl: url };
  },
  isNoWrite: () => true,
  writeArtifact: () => {},
}));

const { fetchPage, newPageStore } = await import("../src/pages.js");

describe("fetchPage and the public-host guard", () => {
  it("never requests the metadata endpoint, and says it refused rather than that the host is down", async () => {
    const outcome = await fetchPage(".", "osm:n1", "http://169.254.169.254/latest/meta-data/", "home", newPageStore());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("not-public");
    expect(fetched).toEqual([]);
  });

  it("still fetches a public page", async () => {
    const outcome = await fetchPage(".", "osm:n1", "https://beispiel.example/", "home", newPageStore());
    expect(outcome.ok).toBe(true);
    expect(fetched).toEqual(["https://beispiel.example/"]);
  });
});
