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

  it("rejects share buttons", () => {
    expect(extractSocials('<a href="https://www.facebook.com/sharer/sharer.php?u=https://x.fr">share</a>', "P1")).toHaveLength(0);
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
