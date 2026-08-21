// Why a fetch produced no citable page — and why the three reasons must stay apart.
//
// A page that answers 200 with an empty body is a JavaScript shell: the site is
// real, a human can open it, and only the machine could not read it. A page that
// answers 403 is a REFUSAL, and a fetch that never got a status at all is an
// UNREACHABLE host. All three used to come back as `no-readable-text`, and
// resolve then wrote the same sentence over each — "a JavaScript-only site we
// cannot read" — onto a prospect record.
//
// Measured on a real Saint-Mandé run: data.inpi.fr answered 403 and
// clinique-veterinaire-saint-mande.familyvets.fr did not answer at all, and both
// were filed as JavaScript-only sites, with the directory URL recorded as the
// company's website. Only cnrs.fr, which really does answer 200 with no text,
// deserved that sentence.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the fake fetcher answers next. Set per test. */
let answer: { status?: number; text?: string; title?: string; finalUrl?: string } = {};
/** Set to throw instead, the way a DNS failure reaches fetchPage. */
let thrown: Error | undefined;

vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  cachedFetchAndExtract: async () => {
    if (thrown) throw thrown;
    return answer;
  },
  fetchAndExtract: async () => {
    if (thrown) throw thrown;
    return answer;
  },
  isNoWrite: () => true,
  writeArtifact: () => {},
}));

const { fetchPage, newPageStore } = await import("../src/pages.js");

beforeEach(() => {
  answer = {};
  thrown = undefined;
});

const fetchIt = (url = "https://example.com/") => fetchPage("/run", "osm:n1", url, "home", newPageStore());

describe("fetchPage tells apart the three ways a page produces no text", () => {
  it("calls a 200 with no text a JavaScript shell — the site is real, we cannot read it", async () => {
    answer = { status: 200, text: "" };
    const out = await fetchIt();
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("no-readable-text");
    expect(out).toMatchObject({ status: 200, chars: 0 });
  });

  it("calls a 403 a refusal, not a JavaScript shell", async () => {
    // data.inpi.fr, on a real run. Describing a host that turned us away as a
    // site "we cannot read" states something false about the page, and the
    // sentence ends up in a prospect record as evidence.
    answer = { status: 403, text: "" };
    const out = await fetchIt("https://data.inpi.fr/entreprises/532821089");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("refused");
    expect(out).toMatchObject({ status: 403 });
  });

  it("calls any other error status a refusal too, rather than an empty page", async () => {
    for (const status of [404, 429, 500, 503]) {
      answer = { status, text: "" };
      const out = await fetchIt();
      expect(out.ok, `HTTP ${status}`).toBe(false);
      if (out.ok) return;
      expect(out.reason, `HTTP ${status}`).toBe("refused");
    }
  });

  it("calls a fetch that never got a status unreachable", async () => {
    // status 0 is what the engine reports when the request itself failed — DNS,
    // TLS, connection refused. There is no page to describe.
    answer = { status: 0, text: "" };
    const out = await fetchIt();
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unreachable");
  });

  it("still calls a thrown fetch unreachable", async () => {
    thrown = new Error("getaddrinfo ENOTFOUND");
    const out = await fetchIt();
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unreachable");
  });

  it("does not call a short body on a 200 a refusal", async () => {
    // The boundary matters in the other direction too: a cookie wall served with
    // a 200 is still a page we could not read, not a host that turned us away.
    answer = { status: 200, text: "Accept cookies" };
    const out = await fetchIt();
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("no-readable-text");
  });
});
