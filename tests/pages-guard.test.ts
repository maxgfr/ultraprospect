// A URL the guard refuses is reported as a refusal, never as "unreachable".
import { describe, expect, it, vi } from "vitest";

const fetched: string[] = [];
vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  cachedFetchAndExtract: async (url: string, opts: { authorizeUrl?: (u: string) => Promise<boolean> } = {}) => {
    fetched.push(url);
    // A public host that redirects to a private one, as a real server would.
    const target = url.includes("redirects.example") ? "http://127.0.0.1:8080/secret" : url;
    if (target !== url && opts.authorizeUrl && !(await opts.authorizeUrl(target))) return { status: 0, text: "", error: "refused", finalUrl: url };
    return { status: 200, text: "x".repeat(500), finalUrl: target };
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

  it("refuses a redirect to a private address on the plain fetch path too", async () => {
    fetched.length = 0;
    const outcome = await fetchPage(".", "osm:n1", "https://redirects.example/", "home", newPageStore());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("not-public");
    expect(outcome.ok === false && outcome.reason === "not-public" && outcome.why).toContain("redirects to http://127.0.0.1:8080/secret");
  });

  it("still fetches a public page", async () => {
    fetched.length = 0;
    const outcome = await fetchPage(".", "osm:n1", "https://beispiel.example/", "home", newPageStore());
    expect(outcome.ok).toBe(true);
    expect(fetched).toEqual(["https://beispiel.example/"]);
  });
});
