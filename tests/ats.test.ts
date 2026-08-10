// The ATS response shapes, pinned.
//
// Six providers, six different JSON schemas for the same thing, none of them
// ours and none of them versioned. When one renames a field the openings do not
// disappear — they arrive as `(untitled)` with no location, which reads as a
// company that is hiring badly rather than as a parser that broke. These tests
// hold each mapping against a captured response so that failure is loud.
import { beforeEach, describe, expect, it, vi } from "vitest";

let payloads: Record<string, unknown> = {};
const requested: string[] = [];

vi.mock("../src/engine.js", () => ({
  httpJson: async (_m: string, url: string) => {
    requested.push(url);
    const match = Object.keys(payloads).find((k) => url.includes(k));
    return match ? { ok: true, status: 200, data: payloads[match] } : { ok: false, status: 404, data: undefined };
  },
}));

const { fetchAllBoards, fetchBoard } = await import("../src/ats.js");

beforeEach(() => {
  payloads = {};
  requested.length = 0;
});

describe("fetchBoard", () => {
  it("maps a Greenhouse board", () => {
    payloads["boards-api.greenhouse.io"] = {
      jobs: [
        {
          title: "Research Engineer",
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1",
          location: { name: "London" },
          updated_at: "2026-08-01T00:00:00Z",
        },
      ],
    };
    return fetchBoard({ provider: "greenhouse", token: "acme", sourceUrl: "s" }).then((jobs) => {
      expect(jobs).toEqual([
        {
          title: "Research Engineer",
          url: "https://job-boards.greenhouse.io/acme/jobs/1",
          location: "London",
          postedAt: "2026-08-01T00:00:00Z",
          via: "greenhouse",
        },
      ]);
    });
  });

  it("maps a Lever board, whose title field is `text`", async () => {
    payloads["api.lever.co"] = [
      {
        text: "Backend Engineer",
        hostedUrl: "https://jobs.lever.co/acme/1",
        categories: { location: "Paris", team: "Platform", commitment: "Full-time" },
        createdAt: 1754000000000,
      },
    ];
    const jobs = await fetchBoard({ provider: "lever", token: "acme", sourceUrl: "s" });
    expect(jobs[0]).toMatchObject({ title: "Backend Engineer", location: "Paris", department: "Platform", employmentType: "Full-time", via: "lever" });
    expect(jobs[0]!.postedAt).toMatch(/^20\d\d-/);
  });

  it("maps an Ashby board", async () => {
    payloads["api.ashbyhq.com"] = {
      jobs: [
        {
          title: "Engineering Manager - EU",
          jobUrl: "https://jobs.ashbyhq.com/ashby/x",
          location: "Remote - European Union",
          department: "Engineering",
          employmentType: "FullTime",
        },
      ],
    };
    const jobs = await fetchBoard({ provider: "ashby", token: "ashby", sourceUrl: "s" });
    expect(jobs[0]).toMatchObject({ title: "Engineering Manager - EU", department: "Engineering", employmentType: "FullTime", via: "ashby" });
  });

  it("maps a Recruitee board", async () => {
    payloads[".recruitee.com"] = { offers: [{ title: "Vendeur", careers_url: "https://acme.recruitee.com/o/vendeur", city: "Lyon", department: "Retail" }] };
    const jobs = await fetchBoard({ provider: "recruitee", token: "acme", sourceUrl: "s" });
    expect(jobs[0]).toMatchObject({ title: "Vendeur", location: "Lyon", via: "recruitee" });
  });

  it("maps a Workable board and joins the location parts", async () => {
    payloads["apply.workable.com"] = { jobs: [{ title: "Ops", url: "https://apply.workable.com/acme/j/1", city: "Nantes", country: "France", type: "full" }] };
    const jobs = await fetchBoard({ provider: "workable", token: "acme", sourceUrl: "s" });
    expect(jobs[0]!.location).toBe("Nantes, France");
  });

  it("reports NO openings for a provider with no keyless API, rather than zero", async () => {
    // welcometothejungle was detected — that is a real signal, the company runs
    // a hiring pipeline — but nothing can be read. The caller sees the provider
    // in atsProviders and no postings, and buildSignals leaves isHiring unset.
    const jobs = await fetchBoard({ provider: "welcometothejungle", token: "acme", sourceUrl: "s" });
    expect(jobs).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("returns nothing rather than throwing when a board 404s", async () => {
    expect(await fetchBoard({ provider: "greenhouse", token: "nope", sourceUrl: "s" })).toEqual([]);
  });

  it("never invents a title", async () => {
    payloads["boards-api.greenhouse.io"] = { jobs: [{ absolute_url: "https://x" }] };
    const jobs = await fetchBoard({ provider: "greenhouse", token: "acme", sourceUrl: "s" });
    expect(jobs[0]!.title).toBe("(untitled)");
  });
});

describe("fetchAllBoards", () => {
  it("deduplicates an opening advertised on two boards mid-migration", async () => {
    payloads["boards-api.greenhouse.io"] = { jobs: [{ title: "Dev", location: { name: "Paris" } }] };
    payloads["api.lever.co"] = [{ text: "Dev", categories: { location: "Paris" } }];
    const jobs = await fetchAllBoards([
      { provider: "greenhouse", token: "a", sourceUrl: "s" },
      { provider: "lever", token: "a", sourceUrl: "s" },
    ]);
    expect(jobs).toHaveLength(1);
  });

  it("keeps two different roles at the same location", async () => {
    payloads["boards-api.greenhouse.io"] = {
      jobs: [
        { title: "Dev", location: { name: "Paris" } },
        { title: "Designer", location: { name: "Paris" } },
      ],
    };
    expect(await fetchAllBoards([{ provider: "greenhouse", token: "a", sourceUrl: "s" }])).toHaveLength(2);
  });
});
