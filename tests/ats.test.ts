// The ATS response shapes, pinned.
//
// Six providers, six different JSON schemas for the same thing, none of them
// ours and none of them versioned. When one renames a field the openings do not
// disappear — they arrive as `(untitled)` with no location, which reads as a
// company that is hiring badly rather than as a parser that broke. These tests
// hold each mapping against a captured response so that failure is loud.
import { beforeEach, describe, expect, it, vi } from "vitest";

let payloads: Record<string, unknown> = {};
/** Providers that answer with a document rather than JSON: Personio serves XML. */
let bodies: Record<string, string> = {};
const requested: string[] = [];

vi.mock("../src/engine.js", () => ({
  httpJson: async (_m: string, url: string) => {
    requested.push(url);
    const match = Object.keys(payloads).find((k) => url.includes(k));
    return match ? { ok: true, status: 200, data: payloads[match] } : { ok: false, status: 404, data: undefined };
  },
  decodeEntities: (x: string) =>
    x
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"'),
  httpGet: async (url: string) => {
    requested.push(url);
    const match = Object.keys(bodies).find((k) => url.includes(k));
    return match
      ? { ok: true, status: 200, body: bodies[match], contentType: "application/xml", url }
      : { ok: false, status: 404, body: "", contentType: "", url };
  },
}));

const { detectBoards, fetchAllBoards, fetchBoard } = await import("../src/ats.js");

beforeEach(() => {
  payloads = {};
  bodies = {};
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

// ---------------------------------------------------------------------------
// The German half. Personio is the ATS most German SMEs run, and until it was
// mapped a Hamburg run could see a careers page, detect nothing, and leave
// `isHiring` unset across most of the city. The fixtures below are the shapes
// the live services actually returned, not the shapes their docs describe.
// ---------------------------------------------------------------------------

/** Captured from https://personio-sog.jobs.personio.de/xml, trimmed. */
const PERSONIO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>1551002</id>
    <subcompany>SOG Business-Software GmbH</subcompany>
    <office>Hamburg</office>
    <department>CSC</department>
    <recruitingCategory>ERP-Berater (m, w, d)</recruitingCategory>
    <name>ERP-Berater (m, w, d)</name>
    <jobDescriptions>
        <jobDescription>
            <name>Deine Rolle</name>
            <value><![CDATA[<p>Als Softwarehersteller ...</p>]]></value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <schedule>full-time</schedule>
    <occupation>program_management</occupation>
    <createdAt>2024-05-03T14:06:09+00:00</createdAt>
</position>
<position>
    <id>1556386</id>
    <office>Hamburg</office>
    <name>Senior Frontend Entwickler (m/w/d)</name>
    <jobDescriptions>
        <jobDescription>
            <name>Was wir suchen</name>
            <value><![CDATA[<p>Freelancer:innen willkommen</p>]]></value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>freelance</employmentType>
    <schedule>part-time</schedule>
    <createdAt>2026-07-01T09:00:00+00:00</createdAt>
</position>
</workzag-jobs>`;

/** Captured from https://megacad-gmbh.jobs.personio.com/search.json, trimmed to two. */
const PERSONIO_SEARCH_JSON = [
  {
    id: 2505736,
    name: "Junior Sales Manager / Outbound Sales (m/w/d) – B2B CAD-Software (Hamburg)",
    employment_type: "Festanstellung",
    seniority: "Berufseinstieg",
    keywords: "Sales,CAD,Telefonvertrieb,Outbound,Software,Vertrieb",
    description: "",
    office: "Hamburg",
    offices: ["Hamburg"],
    schedule: "Vollzeit",
    category: "3 Interviews",
    department: "02 Sales",
    subcompany: "MegaCAD Deutschland GmbH",
  },
  {
    id: 2729221,
    name: "Werkstudent:in IT (m/w/d)",
    employment_type: "Praktikum/Werkstudium",
    seniority: "Studierende/Mitarbeitende im Praktikum/Auszubildende",
    keywords: "",
    description: "",
    office: "Wiesbaden",
    offices: ["Wiesbaden"],
    schedule: "Teilzeit",
    category: "Standard Recruiting",
    department: "12 IT - OPS",
    subcompany: "MegaCAD Deutschland GmbH",
  },
];

describe("Personio", () => {
  it("maps a position, and takes the position's own <name> rather than a jobDescription's", async () => {
    // The trap: <name> appears twice per position — once as the job title and
    // once per description block. A tag scan that takes the first <name> after
    // <position> is right; one that takes the last is wrong, and produces a
    // posting titled "Deine Rolle". Both look plausible in a CSV.
    bodies["personio-sog.jobs.personio.de/xml"] = PERSONIO_XML;
    const jobs = await fetchBoard({ provider: "personio", token: "personio-sog", sourceUrl: "s" });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: "ERP-Berater (m, w, d)",
      location: "Hamburg",
      department: "CSC",
      employmentType: "permanent",
      via: "personio",
    });
    expect(jobs.map((j) => j.title)).not.toContain("Deine Rolle");
  });

  it("carries createdAt through as postedAt, so an unfillable role can be aged", async () => {
    bodies["acme.jobs.personio.de/xml"] = PERSONIO_XML;
    const jobs = await fetchBoard({ provider: "personio", token: "acme", sourceUrl: "s" });
    expect(jobs[0]!.postedAt).toBe("2024-05-03T14:06:09+00:00");
  });

  it("surfaces an explicitly freelance opening", async () => {
    // Personio's own employmentType vocabulary includes `freelance`. That is a
    // company saying, in a structured field, that it hires contractors.
    bodies["acme.jobs.personio.de/xml"] = PERSONIO_XML;
    const jobs = await fetchBoard({ provider: "personio", token: "acme", sourceUrl: "s" });
    expect(jobs[1]).toMatchObject({ title: "Senior Frontend Entwickler (m/w/d)", employmentType: "freelance" });
  });

  it("builds a citable URL per posting from the id", async () => {
    bodies["acme.jobs.personio.de/xml"] = PERSONIO_XML;
    const jobs = await fetchBoard({ provider: "personio", token: "acme", sourceUrl: "s" });
    expect(jobs[0]!.url).toBe("https://acme.jobs.personio.de/job/1551002");
  });

  it("decodes XML entities in a title rather than shipping them raw", async () => {
    bodies["acme.jobs.personio.de/xml"] = `<workzag-jobs><position><id>1</id><name>Consultant &amp; Entwickler</name></position></workzag-jobs>`;
    const jobs = await fetchBoard({ provider: "personio", token: "acme", sourceUrl: "s" });
    expect(jobs[0]!.title).toBe("Consultant & Entwickler");
  });

  it("falls back to search.json when the XML feed is not served for that board", async () => {
    // Measured on a Hamburg run: `megacad-gmbh.jobs.personio.de/xml` and its
    // `.com` twin both answer 404, while `search.json` answers 200 with four
    // real openings. Both endpoints exist in the wild — personio-sog serves
    // BOTH — so a board that 404s on /xml is not a board with no openings, and
    // reporting it as unreadable hides hiring that is one keyless request away.
    payloads["megacad-gmbh.jobs.personio.de/search.json"] = PERSONIO_SEARCH_JSON;
    const jobs = await fetchBoard({ provider: "personio", token: "megacad-gmbh", sourceUrl: "s" });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: "Junior Sales Manager / Outbound Sales (m/w/d) – B2B CAD-Software (Hamburg)",
      location: "Hamburg",
      department: "02 Sales",
      employmentType: "Festanstellung",
      via: "personio",
    });
    expect(jobs[0]!.url).toBe("https://megacad-gmbh.jobs.personio.de/job/2505736");
  });

  it("prefers the XML feed and does not spend a second request when it answers", async () => {
    // /xml carries what search.json does not: the canonical employmentType
    // vocabulary — `freelance`, the one that says a company hires contractors —
    // and createdAt. It stays the first choice; the fallback is a fallback.
    bodies["personio-sog.jobs.personio.de/xml"] = PERSONIO_XML;
    payloads["personio-sog.jobs.personio.de/search.json"] = PERSONIO_SEARCH_JSON;
    const jobs = await fetchBoard({ provider: "personio", token: "personio-sog", sourceUrl: "s" });
    expect(jobs.map((j) => j.employmentType)).toEqual(["permanent", "freelance"]);
    expect(requested.filter((u) => u.includes("search.json"))).toHaveLength(0);
  });

  it("returns nothing rather than throwing when neither endpoint is served", async () => {
    expect(await fetchBoard({ provider: "personio", token: "nope", sourceUrl: "s" })).toEqual([]);
  });
});

describe("SmartRecruiters", () => {
  it("maps a posting", async () => {
    // Captured from api.smartrecruiters.com/v1/companies/smartrecruiters/postings.
    payloads["api.smartrecruiters.com"] = {
      totalFound: 1,
      content: [
        {
          id: "744000143115219",
          name: "Senior Information Security Engineer",
          company: { identifier: "smartrecruiters" },
          releasedDate: "2026-08-12T14:04:56.128Z",
          location: { city: "Poland", region: "REMOTE", fullLocation: "Poland, REMOTE, Poland" },
          department: { label: "Engineering" },
          typeOfEmployment: { label: "Permanent" },
        },
      ],
    };
    const jobs = await fetchBoard({ provider: "smartrecruiters", token: "smartrecruiters", sourceUrl: "s" });
    expect(jobs[0]).toMatchObject({
      title: "Senior Information Security Engineer",
      location: "Poland, REMOTE, Poland",
      department: "Engineering",
      employmentType: "Permanent",
      postedAt: "2026-08-12T14:04:56.128Z",
      via: "smartrecruiters",
    });
    expect(jobs[0]!.url).toContain("744000143115219");
  });
});

describe("boards detected but not readable", () => {
  // softgarden renders its openings client-side out of a Wicket application and
  // publishes no keyless JSON; join.com's public endpoint did not resolve for a
  // board token. Detection is still worth having — it says this company runs a
  // real hiring pipeline — but zero openings must NOT be reported as "not
  // hiring". buildSignals leaves isHiring unset when a provider is present and
  // no postings came back, and that is the contract these two rely on.
  it.each(["softgarden", "join"])("reports no openings for %s without calling anything", async (provider) => {
    const jobs = await fetchBoard({ provider, token: "acme", sourceUrl: "s" });
    expect(jobs).toEqual([]);
    expect(requested).toHaveLength(0);
  });
});

describe("detectBoards", () => {
  it.each([
    ["personio", 'href="https://youhamburg.jobs.personio.de/"', "youhamburg"],
    // Personio serves the same board on .com; a run that only knew .de missed it.
    ["personio", 'href="https://quibiq-hamburg.jobs.personio.com/"', "quibiq-hamburg"],
    ["smartrecruiters", 'href="https://careers.smartrecruiters.com/AcmeGmbH"', "AcmeGmbH"],
    ["smartrecruiters", 'href="https://jobs.smartrecruiters.com/AcmeGmbH/744"', "AcmeGmbH"],
    ["softgarden", 'href="https://ibv-hamburg.softgarden.io/de/vacancies"', "ibv-hamburg"],
    // softgarden's second hostname form, seen on real Hamburg boards.
    ["softgarden", 'href="https://tegtmeier-inkubator.career.softgarden.de/"', "tegtmeier-inkubator"],
    ["join", 'href="https://join.com/companies/acme-gmbh"', "acme-gmbh"],
  ])("finds a %s board in a link", (provider, html, token) => {
    expect(detectBoards(html, "https://acme.de/karriere")).toContainEqual({ provider, token, sourceUrl: "https://acme.de/karriere" });
  });

  it("does not mistake the provider's own marketing pages for a customer board", () => {
    const html = 'a href="https://www.personio.de/" and href="https://www.softgarden.io/produkt"';
    expect(detectBoards(html, "s").map((b) => b.token)).not.toContain("www");
  });
});
