import { describe, expect, it } from "vitest";
import { buildSignals, extractEmails, extractLanguages, extractLegalId, extractPhones, extractSocials, roleOf, sameOriginLinks } from "../src/signals.js";
import { detectBoards } from "../src/ats.js";
import { pickByRole } from "../src/enrich.js";

describe("roleOf", () => {
  it("recognises the roles that matter, in French and English", () => {
    expect(roleOf("https://x.fr/")).toBe("home");
    expect(roleOf("https://x.fr/recrutement")).toBe("careers");
    expect(roleOf("https://x.fr/nous-rejoindre/")).toBe("careers");
    expect(roleOf("https://x.fr/careers")).toBe("careers");
    expect(roleOf("https://x.fr/tarifs")).toBe("pricing");
    expect(roleOf("https://x.fr/a-propos")).toBe("about");
    expect(roleOf("https://x.fr/mentions-legales")).toBe("legal");
    expect(roleOf("https://x.fr/notre-equipe")).toBe("team");
    expect(roleOf("https://x.fr/realisations")).toBe("cases");
    expect(roleOf("https://x.fr/blog/un-article")).toBe("news");
  });

  it("falls back to other rather than guessing", () => {
    expect(roleOf("https://x.fr/quelque-chose")).toBe("other");
  });

  it("tolerates a string that is not a URL", () => {
    expect(roleOf("/tarifs")).toBe("pricing");
  });
});

describe("pickByRole", () => {
  it("prefers a section's landing page over an article inside it", () => {
    const picked = pickByRole(["https://x.fr/blog/2024/one", "https://x.fr/blog", "https://x.fr/blog/2024/two"], ["news"]);
    expect(picked.get("news")).toBe("https://x.fr/blog");
  });

  it("ignores roles it was not asked for", () => {
    const picked = pickByRole(["https://x.fr/tarifs", "https://x.fr/blog"], ["news"]);
    expect(picked.has("pricing")).toBe(false);
    expect(picked.get("news")).toBe("https://x.fr/blog");
  });
});

describe("extractEmails", () => {
  it("reads a mailto link, which survives text obfuscation", () => {
    const found = extractEmails("", '<a href="mailto:contact@x.fr">nous écrire</a>', "P1");
    expect(found.map((e) => e.value)).toEqual(["contact@x.fr"]);
    expect(found[0]!.from).toBe("P1");
  });

  it("reads an address written in the page text", () => {
    expect(extractEmails("écrivez à hello@x.fr.", "", "P2").map((e) => e.value)).toEqual(["hello@x.fr"]);
  });

  it("rejects asset filenames that look like addresses", () => {
    expect(extractEmails("logo@2x.png and sentry@1.2.3.js", "", "P1")).toHaveLength(0);
  });

  it("rejects placeholder addresses", () => {
    expect(extractEmails("nom@example.com no-reply@x.fr", "", "P1")).toHaveLength(0);
  });

  it("carries the page id on every address, because the gate re-checks it", () => {
    const found = extractEmails("a@x.fr", '<a href="mailto:b@x.fr">b</a>', "P7");
    expect(found.every((e) => e.from === "P7" && e.lane === "web")).toBe(true);
  });
});

describe("extractPhones", () => {
  it("reads tel: links only", () => {
    const found = extractPhones('<a href="tel:+33 1 43 28 25 10">appeler</a>', "P1");
    expect(found.map((p) => p.value)).toEqual(["+33143282510"]);
  });

  it("does NOT scrape digit runs out of the page text", () => {
    // Page text is full of SIRETs, prices, dates and opening hours. A wrong
    // phone number in a prospect file is worse than a missing one: somebody
    // dials it.
    expect(extractPhones("SIRET 30247464801175 — ouvert de 09 00 à 19 00", "P1")).toHaveLength(0);
  });

  it("rejects a number too short to be one", () => {
    expect(extractPhones('<a href="tel:12345">x</a>', "P1")).toHaveLength(0);
  });
});

describe("extractSocials", () => {
  it("keeps a real profile", () => {
    const found = extractSocials('<a href="https://www.instagram.com/lesofficiers.vincennes/">ig</a>', "P1");
    expect(found.map((s) => s.value)).toEqual(["https://www.instagram.com/lesofficiers.vincennes/"]);
  });

  it("REJECTS an embedded video, which is content and not a channel", () => {
    // Seen in the first real run: a café's homepage embeds a YouTube video and
    // the video id was recorded as their social profile.
    expect(extractSocials('<iframe src="https://www.youtube.com/embed/hB8FxPdU3Xo?feature=oe"></iframe>', "P1")).toHaveLength(0);
  });

  it("rejects share buttons, in both their shapes", () => {
    expect(extractSocials('<a href="https://www.facebook.com/sharer/sharer.php?u=https://x.fr">share</a>', "P1")).toHaveLength(0);
    // Found on a Vincennes pizzeria, recorded as their Twitter profile.
    expect(extractSocials('<a href="https://twitter.com/home?status=https://www.renine.fr/">tweet</a>', "P1")).toHaveLength(0);
  });

  it("rejects a bare link to the network itself", () => {
    expect(extractSocials('<a href="https://facebook.com/">fb</a>', "P1")).toHaveLength(0);
  });

  it("rejects the tracking pixel endpoint", () => {
    expect(extractSocials('<img src="https://www.facebook.com/tr?id=123&ev=PageView">', "P1")).toHaveLength(0);
  });
});

describe("extractLegalId", () => {
  it("reads an intra-community VAT number", () => {
    expect(extractLegalId("TVA FR 32 302474648")).toBe("FR32302474648");
  });

  it("reads a labelled SIRET", () => {
    expect(extractLegalId("SIRET : 302 474 648 01175")).toBe("30247464801175");
  });

  it("reads a labelled SIREN", () => {
    expect(extractLegalId("SIREN 302 474 648")).toBe("302474648");
  });

  it("does not invent one from a bare number run", () => {
    // An unlabelled nine-digit number is a phone number, a price or a date.
    expect(extractLegalId("appelez le 01 43 28 25 10")).toBeUndefined();
  });
});

describe("extractLanguages", () => {
  it("reads the html lang and any hreflang", () => {
    const langs = extractLanguages('<html lang="fr"><link rel="alternate" hreflang="en" href="/en">');
    expect(langs).toContain("fr");
    expect(langs).toContain("en");
  });
});

describe("sameOriginLinks", () => {
  it("resolves relative links and drops other origins", () => {
    const html = '<a href="/tarifs">t</a><a href="https://other.example/x">o</a><a href="contact">c</a>';
    const links = sameOriginLinks(html, "https://x.fr/a/b");
    expect(links).toContain("https://x.fr/tarifs");
    expect(links).toContain("https://x.fr/a/contact");
    expect(links.some((l) => l.includes("other.example"))).toBe(false);
  });

  it("strips fragments so one page is not fetched five times", () => {
    const links = sameOriginLinks('<a href="/x#one">a</a><a href="/x#two">b</a>', "https://x.fr/");
    expect(links).toEqual(["https://x.fr/x"]);
  });
});

describe("detectBoards", () => {
  it("finds a Greenhouse board from a link", () => {
    expect(detectBoards('<a href="https://boards.greenhouse.io/anthropic">jobs</a>', "https://x.fr")).toEqual([
      { provider: "greenhouse", token: "anthropic", sourceUrl: "https://x.fr" },
    ]);
  });

  it("finds a board embedded in an iframe src", () => {
    const boards = detectBoards('<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe>', "https://x.fr");
    expect(boards[0]).toMatchObject({ provider: "greenhouse", token: "acme" });
  });

  it("finds Lever, Ashby, Recruitee and Workable", () => {
    const html = `
      <a href="https://jobs.lever.co/leverdemo">l</a>
      <a href="https://jobs.ashbyhq.com/ashby">a</a>
      <a href="https://acme.recruitee.com/">r</a>
      <a href="https://apply.workable.com/acme/">w</a>`;
    expect(
      detectBoards(html, "https://x.fr")
        .map((b) => b.provider)
        .sort(),
    ).toEqual(["ashby", "lever", "recruitee", "workable"]);
  });

  it("does not mistake a provider's own pages for a customer token", () => {
    expect(detectBoards('<a href="https://boards.greenhouse.io/www">x</a>', "https://x.fr")).toHaveLength(0);
  });

  it("deduplicates the same board linked twice", () => {
    const html = '<a href="https://jobs.lever.co/acme">a</a><a href="https://jobs.lever.co/acme/1234">b</a>';
    expect(detectBoards(html, "https://x.fr")).toHaveLength(1);
  });
});

describe("buildSignals", () => {
  const page = (role: any, html: string, text = "some text") => ({
    record: { id: "P1", url: "https://x.fr/", role, fetchedAt: "", chars: 9, extract: "p" } as any,
    text,
    html,
  });

  it("reports a pricing page only when one was actually fetched", () => {
    expect(buildSignals({ pages: [page("home", "")], jobs: [], atsProviders: [], siteReachable: true }).hasPricingPage).toBe(false);
    expect(buildSignals({ pages: [page("pricing", "")], jobs: [], atsProviders: [], siteReachable: true }).hasPricingPage).toBe(true);
  });

  it("identifies the CMS from its fingerprint", () => {
    expect(buildSignals({ pages: [page("home", '<link href="/wp-content/themes/x/style.css">')], jobs: [], atsProviders: [], siteReachable: true }).cms).toBe(
      "WordPress",
    );
  });

  it("says NOT HIRING only when it actually looked", () => {
    // No careers page and no board: we looked where hiring would be and there
    // was none. That is a fact worth stating.
    expect(buildSignals({ pages: [page("home", "")], jobs: [], atsProviders: [], siteReachable: true }).isHiring).toBe(false);
  });

  it("leaves hiring UNKNOWN when a board exists but could not be read", () => {
    // "Not hiring" and "we could not look" are different facts, and the second
    // must never be presented as the first.
    const s = buildSignals({ pages: [page("careers", "")], jobs: [], atsProviders: ["welcometothejungle"], siteReachable: true });
    expect(s.isHiring).toBeUndefined();
    expect(s.atsProviders).toEqual(["welcometothejungle"]);
  });

  it("counts openings when they were read", () => {
    const s = buildSignals({ pages: [page("careers", "")], jobs: [{ title: "Dev", via: "lever" }], atsProviders: ["lever"], siteReachable: true });
    expect(s.isHiring).toBe(true);
    expect(s.openRoles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The freelance signals.
//
// Everything here stays on the file's own rule: a COUNT or a PRESENCE, never a
// conclusion. "Two roles matched your filter, the oldest open for 840 days, and
// the term you supplied appears on the careers page" is measured. "This company
// needs a freelancer" is a judgement, and it is the agent's, not the engine's.
// ---------------------------------------------------------------------------

const page = (id: string, role: string, text: string) => ({
  record: { id, role, url: `https://acme.de/${role}`, fetchedAt: "2026-08-01T00:00:00Z", status: 200, title: "" } as never,
  text,
  html: `<html lang="de"><body>${text}</body></html>`,
});

const base = { jobs: [], atsProviders: [], siteReachable: true, countryCode: "de" as const };

describe("matchedRoles and oldestOpenRoleDays", () => {
  const jobs = [
    { title: "Senior Frontend Entwickler (m/w/d)", postedAt: "2024-05-03T00:00:00Z", via: "personio" },
    { title: "Backend Engineer", postedAt: "2026-08-01T00:00:00Z", via: "personio" },
    { title: "Buchhalter:in", postedAt: "2026-08-10T00:00:00Z", via: "personio" },
  ];

  it("counts the roles matching the CALLER's filter, and nothing about dev is baked in", () => {
    // The engine must not know what "a developer" is. It counts what it was
    // asked to count, and records the terms beside the number so the count is
    // self-describing rather than a magic figure someone has to trust.
    const s = buildSignals({ ...base, jobs, atsProviders: ["personio"], pages: [page("P1", "home", "x")], roleFilter: ["entwickler", "engineer"] });
    expect(s.matchedRoles).toBe(2);
    expect(s.roleFilter).toEqual(["entwickler", "engineer"]);
    expect(s.openRoles).toBe(3);
  });

  it("serves a filter that has nothing to do with software", () => {
    const s = buildSignals({
      ...base,
      jobs: [
        { title: "Pflegefachkraft (m/w/d)", via: "personio" },
        { title: "Backend Engineer", via: "personio" },
      ],
      atsProviders: ["personio"],
      pages: [page("P1", "home", "x")],
      roleFilter: ["pflege"],
    });
    expect(s.matchedRoles).toBe(1);
  });

  it("leaves the count UNSET when no filter was given, rather than reporting zero", () => {
    // Zero would read as "none of these roles interest you". Unset reads as
    // "nobody said what to look for", which is what happened.
    const s = buildSignals({ ...base, jobs, atsProviders: ["personio"], pages: [page("P1", "home", "x")] });
    expect(s.matchedRoles).toBeUndefined();
    expect(s.openRoles).toBe(3);
  });

  it("ages the oldest opening, because a role nobody can fill is the signal", () => {
    const s = buildSignals({ ...base, jobs, atsProviders: ["personio"], pages: [page("P1", "home", "x")], now: "2026-08-21T00:00:00Z" });
    expect(s.oldestOpenRoleDays).toBe(840);
  });

  it("leaves the age unset when no posting carries a date", () => {
    const s = buildSignals({ ...base, jobs: [{ title: "Dev", via: "site" }], atsProviders: ["personio"], pages: [page("P1", "home", "x")] });
    expect(s.oldestOpenRoleDays).toBeUndefined();
  });

  it("does not turn an unreadable board into zero dev roles", () => {
    // softgarden detected, nothing readable. openRoles is 0 because we read
    // nothing, matchedRoles likewise — and isHiring stays undefined, which is what
    // stops any of this being reported as "not hiring".
    const s = buildSignals({ ...base, atsProviders: ["softgarden"], pages: [page("P2", "careers", "Offene Stellen")] });
    expect(s.isHiring).toBeUndefined();
    expect(s.matchedRoles).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// termMentions — a mechanism, not a vocabulary.
//
// The engine ships no word list. Which words mean "this company buys outside
// work" in Portugal is a translation problem, and translation belongs to the
// agent, which can read the country's own labour vocabulary and check the
// phrasing against the live web. What the engine owes is: find the caller's
// terms verbatim, say which page each came from, and refuse to look on a page
// where the words would mean something else.
// ---------------------------------------------------------------------------

describe("termMentions", () => {
  it("finds nothing at all when the caller supplied no lexicon", () => {
    // Not an empty result because the site is clean — an empty result because
    // nobody said what to look for. The engine has no default to fall back on.
    const s = buildSignals({ ...base, pages: [page("P2", "careers", "Wir arbeiten mit Freiberuflern.")] });
    expect(s.termMentions).toEqual([]);
    expect(s.termLexicon).toBeUndefined();
  });

  it("finds the caller's term verbatim, with the page and the surrounding line", () => {
    const s = buildSignals({
      ...base,
      pages: [page("P2", "careers", "Wir arbeiten regelmäßig mit Freiberuflern zusammen.")],
      termLexicon: ["Freiberufler"],
    });
    expect(s.termMentions).toHaveLength(1);
    expect(s.termMentions[0]).toMatchObject({ from: "P2", lane: "web" });
    expect(s.termMentions[0]!.note).toContain("zusammen");
    expect(s.termLexicon).toEqual(["Freiberufler"]);
  });

  it("carries a suffixing inflection but not a compound", () => {
    const hit = buildSignals({ ...base, pages: [page("P2", "careers", "mit Freiberuflern")], termLexicon: ["Freiberufler"] });
    expect(hit.termMentions).toHaveLength(1);
    const miss = buildSignals({ ...base, pages: [page("P2", "careers", "Freelancerschutzgesetzgebung")], termLexicon: ["Freelancer"] });
    expect(miss.termMentions).toEqual([]);
  });

  it("works in any language, because the language never reaches the engine", () => {
    // The agent translated these. The engine cannot tell them apart, which is
    // exactly the property that makes it work outside the languages one author
    // happened to speak.
    for (const [text, term] of [
      ["Statut auto-entrepreneur ou portage salarial accepté.", "portage salarial"],
      ["Buscamos profesionales autónomos.", "autónomo"],
      ["Wij werken graag met ZZP'ers.", "ZZP"],
      ["Współpraca na zasadzie samozatrudnienia.", "samozatrudnieni"],
    ] as const) {
      const s = buildSignals({ ...base, pages: [page("P2", "careers", text)], termLexicon: [term] });
      expect(s.termMentions.length, `${term} in "${text}"`).toBeGreaterThan(0);
    }
  });

  it("reads only the careers page by default, where the words are about hiring", () => {
    // Measured: scanning home and legal produced 48 hits on a Hamburg run and
    // every sampled one was a false positive — GDPR boilerplate naming data
    // processors, a law firm naming the clients it advises.
    const legal = buildSignals({
      ...base,
      pages: [page("P9", "legal", "Externe Dienstleister verarbeiten Ihre Daten.")],
      termLexicon: ["Externe Dienstleister"],
    });
    expect(legal.termMentions).toEqual([]);
  });

  it("lets the caller widen the pages deliberately, rather than silently", () => {
    const s = buildSignals({
      ...base,
      pages: [page("P1", "home", "Wir suchen Freiberufler.")],
      termLexicon: ["Freiberufler"],
      termRoles: ["home", "careers"],
    });
    expect(s.termMentions).toHaveLength(1);
  });
});

describe("oldestOpenRoleDays ages the roles the caller asked about", () => {
  // Measured on a Hamburg run: the oldest posting on two German boards was an
  // "Initiativbewerbung" — a standing invitation to apply speculatively, which
  // by construction never closes. It made one company look like it had failed
  // to fill a role for 1766 days when its oldest real vacancy was two months
  // old. An evergreen listing poisons the one reading this number exists for.
  //
  // The engine must not learn what "Initiativbewerbung" means — that is one
  // country's word, and the next country has another. But the caller ALREADY
  // says which roles matter, and an evergreen catch-all is precisely what a
  // real filter excludes. So the age follows the filter.
  const jobs = [
    { title: "Initiativbewerbung", postedAt: "2021-10-20T00:00:00Z", via: "personio" },
    { title: "DevOps Engineer (m/w/d)", postedAt: "2025-10-20T00:00:00Z", via: "personio" },
  ];

  it("ages only the matching roles when a filter was given", () => {
    const s = buildSignals({
      ...base,
      jobs,
      atsProviders: ["personio"],
      pages: [page("P1", "home", "x")],
      roleFilter: ["engineer"],
      now: "2026-08-21T00:00:00Z",
    });
    expect(s.matchedRoles).toBe(1);
    expect(s.oldestOpenRoleDays).toBe(305);
  });

  it("ages every role when no filter was given, because nothing said otherwise", () => {
    const s = buildSignals({ ...base, jobs, atsProviders: ["personio"], pages: [page("P1", "home", "x")], now: "2026-08-21T00:00:00Z" });
    expect(s.oldestOpenRoleDays).toBe(1766);
  });

  it("leaves the age unset when a filter matched nothing", () => {
    // Not zero, and not the age of a role they never asked about.
    const s = buildSignals({
      ...base,
      jobs,
      atsProviders: ["personio"],
      pages: [page("P1", "home", "x")],
      roleFilter: ["pflege"],
      now: "2026-08-21T00:00:00Z",
    });
    expect(s.matchedRoles).toBe(0);
    expect(s.oldestOpenRoleDays).toBeUndefined();
  });
});
