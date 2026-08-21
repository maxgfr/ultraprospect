// What a website tells you about the company behind it, mechanically.
//
// Everything here is a COUNT or a PRESENCE, never a conclusion. "Has a pricing
// page", "12 open roles", "sitemap's newest entry is from March" — the engine
// measures; the agent decides whether any of it means the company is worth a
// call. That split is the whole reason the numbers can be trusted: a measured
// signal cannot be talked into existing.
//
// The one judgement encoded here is what counts as a signal at all, and it is
// tuned for prospecting: a careers page and a recent blog post say more about
// whether a company is alive and spending than any amount of copy on its
// homepage.
import { extractJsonLd, htmlToText } from "./engine.js";
import type { JobPosting, PageRecord, PageRole, Signals, SourcedValue } from "./types.js";

/**
 * Path fragments that identify a page's job.
 *
 * French and English first, because that is what the corpus was built on, then
 * German, Spanish and Italian — a Berlin run whose careers page is `/karriere`
 * would otherwise report "no careers page" and, through `Signals.isHiring`,
 * assert that a hiring company is not hiring. Absence is a finding here, so a
 * missing pattern does not produce a gap: it produces a wrong answer.
 */
const ROLE_PATTERNS: { role: PageRole; re: RegExp }[] = [
  {
    role: "careers",
    re: /(?:^|\/)(?:careers?|jobs?|emplois?|recrutement|nous-rejoindre|rejoignez|join-us|hiring|carriere|carrières?|karriere|stellen|stellenangebote|jobboerse|empleo|trabaja-con-nosotros|ofertas-de-empleo|lavora-con-noi)(?:\/|$|\.)/i,
  },
  { role: "pricing", re: /(?:^|\/)(?:pricing|tarifs?|prix|nos-tarifs|abonnements?|plans?|devis|preise|preisliste|precios|tarifas|prezzi)(?:\/|$|\.)/i },
  {
    role: "about",
    re: /(?:^|\/)(?:about|about-us|a-propos|à-propos|qui-sommes-nous|notre-histoire|entreprise|company|ueber-uns|über-uns|unternehmen|wir-ueber-uns|sobre-nosotros|quienes-somos|empresa|chi-siamo)(?:\/|$|\.)/i,
  },
  {
    role: "team",
    re: /(?:^|\/)(?:team|equipe|équipe|notre-equipe|people|staff|collaborateurs|direction|mitarbeiter|ansprechpartner|equipo|nuestro-equipo)(?:\/|$|\.)/i,
  },
  { role: "contact", re: /(?:^|\/)(?:contact|contactez-nous|nous-contacter|contact-us|kontakt|kontaktieren|contacto|contatti)(?:\/|$|\.)/i },
  {
    role: "legal",
    // The legal page is the one this tool most depends on outside France: it is
    // where German and Spanish law puts the registration number that `confirm`
    // turns into a register record.
    re: /(?:^|\/)(?:mentions-legales|mentions-légales|legal|legal-notice|legal-notices|impressum|imprint|anbieterkennzeichnung|aviso-legal|informacion-legal|note-legali|cgv|cgu|conditions-generales|privacy|confidentialite|datenschutz)(?:\/|$|\.)/i,
  },
  { role: "services", re: /(?:^|\/)(?:services?|prestations?|expertises?|solutions?|savoir-faire|metiers?|métiers?)(?:\/|$|\.)/i },
  { role: "products", re: /(?:^|\/)(?:products?|produits?|boutique|shop|catalogue|collections?)(?:\/|$|\.)/i },
  { role: "cases", re: /(?:^|\/)(?:case-stud(?:y|ies)|references?|réalisations?|realisations|portfolio|clients?|temoignages?|témoignages?)(?:\/|$|\.)/i },
  { role: "news", re: /(?:^|\/)(?:news|blog|actualites?|actualités?|articles?|presse|press)(?:\/|$|\.)/i },
];

/** Classify a URL by what the page is for. */
export function roleOf(url: string): PageRole {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  if (path === "/" || path === "") return "home";
  for (const { role, re } of ROLE_PATTERNS) if (re.test(path)) return role;
  return "other";
}

/** Content-management systems, from the fingerprints they leave in the HTML. */
const CMS_FINGERPRINTS: [string, RegExp][] = [
  ["WordPress", /wp-content|wp-includes|name="generator"[^>]*WordPress/i],
  ["Shopify", /cdn\.shopify\.com|Shopify\.theme/i],
  ["Wix", /static\.wixstatic\.com|X-Wix-/i],
  ["Squarespace", /squarespace\.com|static1\.squarespace/i],
  ["Webflow", /assets(?:-global)?\.website-files\.com|generator"[^>]*Webflow/i],
  ["Drupal", /generator"[^>]*Drupal|sites\/all\/(?:themes|modules)/i],
  ["Joomla", /generator"[^>]*Joomla/i],
  ["PrestaShop", /generator"[^>]*PrestaShop|\/themes\/[^"']*\/assets\/js\/theme/i],
  ["Magento", /Magento_|mage\/cookies/i],
  ["HubSpot CMS", /hs-scripts\.com|hubspotusercontent/i],
  ["Framer", /framerusercontent\.com/i],
  ["Odoo", /generator"[^>]*Odoo|web\/static\/src/i],
  ["Next.js", /\/_next\/static\//i],
  ["Nuxt", /\/_nuxt\//i],
];

const ANALYTICS_FINGERPRINTS: [string, RegExp][] = [
  ["Google Analytics", /googletagmanager\.com\/gtag|google-analytics\.com|gtag\('config'/i],
  ["Google Tag Manager", /googletagmanager\.com\/gtm\.js/i],
  ["Matomo", /matomo\.js|piwik\.js/i],
  ["Plausible", /plausible\.io\/js/i],
  ["Fathom", /cdn\.usefathom\.com/i],
  ["Hotjar", /static\.hotjar\.com/i],
  ["Meta Pixel", /connect\.facebook\.net\/[^"']*\/fbevents\.js/i],
  ["LinkedIn Insight", /snap\.licdn\.com/i],
  ["HubSpot", /js\.hs-scripts\.com/i],
  ["Intercom", /widget\.intercom\.io/i],
  ["Crisp", /client\.crisp\.chat/i],
  ["Axeptio", /axeptio\.imgix\.net|axept\.io/i],
];

const ECOMMERCE_FINGERPRINTS = /add-to-cart|ajouter-au-panier|data-product-id|woocommerce|shopify|prestashop|panier|checkout|stripe\.com\/v3|paypal\.com\/sdk/i;

function fingerprints(html: string, table: readonly [string, RegExp][]): string[] {
  return table.filter(([, re]) => re.test(html)).map(([name]) => name);
}

/**
 * Email addresses published on the page.
 *
 * Verbatim only — this never constructs one. The tool's hardest rule is that a
 * contact which was not observed is never written, and a `firstname.lastname@`
 * assembled from a naming convention is exactly the fabrication that rule
 * exists to prevent: it is plausible, it is unfalsifiable at a glance, and it
 * will be emailed.
 */
export function extractEmails(text: string, html: string, pageId: string): SourcedValue[] {
  const out = new Map<string, SourcedValue>();
  // `mailto:` first: it survives the obfuscation that hides an address from the
  // rendered text, and it is unambiguous.
  for (const m of html.matchAll(/mailto:([^"'?>\s]+@[^"'?>\s]+)/gi)) {
    const value = decodeURIComponent(m[1]!).toLowerCase();
    if (isPlausibleEmail(value)) out.set(value, { value, from: pageId, lane: "web", note: "mailto link" });
  }
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g)) {
    const value = m[0].toLowerCase().replace(/[.,;:]$/, "");
    if (isPlausibleEmail(value) && !out.has(value)) out.set(value, { value, from: pageId, lane: "web", note: "in the page text" });
  }
  return [...out.values()];
}

function isPlausibleEmail(value: string): boolean {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value)) return false;
  // Asset filenames and tracking pixels look like addresses often enough to
  // matter: `logo@2x.png`, `sentry@1.2.3.js`.
  if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i.test(value)) return false;
  if (/^(?:example|test|no-?reply|your|email|nom|prenom)@/i.test(value)) return false;
  return true;
}

/** Phone numbers, from `tel:` links only. */
export function extractPhones(html: string, pageId: string): SourcedValue[] {
  const out = new Map<string, SourcedValue>();
  // Only `tel:` links, deliberately. Scraping digit runs out of page text picks
  // up SIRETs, prices, opening hours and dates, and a wrong phone number in a
  // prospect file is worse than a missing one — somebody dials it.
  for (const m of html.matchAll(/tel:([+0-9().\s-]{6,})/gi)) {
    const raw = m[1]!.replace(/[\s.()-]/g, "");
    if (raw.replace(/\D/g, "").length < 8) continue;
    out.set(raw, { value: raw, from: pageId, lane: "web", note: "tel: link" });
  }
  return [...out.values()];
}

/**
 * URLs on a social host that are not the company's PROFILE.
 *
 * Three kinds, and all three showed up in the first real run:
 *   - embedded content: `youtube.com/embed/<id>` is a video in the page, and a
 *     café's homepage carrying one does not mean that video id is their channel;
 *   - share buttons, in all their shapes: `facebook.com/sharer/...?u=<our own
 *     url>` and `twitter.com/home?status=<our own url>` — the second one showed
 *     up on a Vincennes pizzeria and was recorded as their Twitter profile;
 *   - the network's own furniture: login, privacy, developer pages.
 * A CSV column headed "social profiles" containing a video id is worse than an
 * empty one — somebody clicks it.
 */
const NOT_A_PROFILE =
  /\/(?:sharer|share|intent|embed|watch|shorts|login|signup|home|policies|privacy|legal|about|developers?|plugins?|tr\?id=)\b|[?&](?:u|text|url|status|via)=/i;

/** Social profiles linked from the page. */
export function extractSocials(html: string, pageId: string): SourcedValue[] {
  const out = new Map<string, SourcedValue>();
  const re = /https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?(facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com)\/[^\s"'<>)]+/gi;
  for (const m of html.matchAll(re)) {
    const value = m[0].replace(/[)"'<>]+$/, "");
    if (NOT_A_PROFILE.test(value)) continue;
    // A bare host with nothing after it is a link to the network, not a profile.
    try {
      if (new URL(value).pathname.replace(/\/+$/, "").length < 2) continue;
    } catch {
      continue;
    }
    out.set(value, { value, from: pageId, lane: "web", note: `${m[1]} link` });
  }
  return [...out.values()];
}

// The legal-identifier patterns moved to src/legal-notice.ts, where they became
// per-country: a German Impressum carries an HRB number and a registry court, a
// Spanish aviso legal a CIF, and neither is a SIREN. Re-exported here because
// `Signals.legalIdOnSite` is the field the rest of the run reads.
export { extractLegalId } from "./legal-notice.js";
import { extractLegalId as readLegalId } from "./legal-notice.js";

/** Language codes the page declares, from `<html lang>` and hreflang links. */
export function extractLanguages(html: string): string[] {
  const langs = new Set<string>();
  const htmlLang = /<html[^>]*\slang=["']([a-z]{2})/i.exec(html);
  if (htmlLang) langs.add(htmlLang[1]!.toLowerCase());
  for (const m of html.matchAll(/hreflang=["']([a-z]{2})/gi)) langs.add(m[1]!.toLowerCase());
  return [...langs];
}

/**
 * Terms by which a company says, in its own words, that it works with people it
 * has not employed.
 *
 * German first, because German law and German usage are precise about it:
 * `Freiberufler` is a legal status, `Werkvertrag` is a contract form, and
 * `freiberuflich` on a careers page is a company describing how it buys work.
 * These are the strongest weak signal a public website carries — far stronger
 * than the presence of a careers page, and unlike an open role they do not
 * expire.
 *
 * Matched on word boundaries, not as substrings: a blog post about
 * `Freelancerschutzgesetzgebung` is not a company hiring a contractor.
 */
const FREELANCE_TERMS = [
  // German — the vocabulary is legal, so it is precise: `Freiberufler` is a
  // status, `Werkvertrag` a contract form.
  "Freelancer:innen",
  "Freiberufler:innen",
  "Freiberufler",
  "freiberuflich",
  "Werkvertrag",
  "Werkverträge",
  "auf Projektbasis",
  "Projektbasis",
  "Subunternehmer",
  // English
  "Freelancer",
  "Freelance",
  "Contractor",
  "self-employed",
  "contract basis",
  // French — `portage salarial` and `auto-entrepreneur` have no equivalent
  // elsewhere and are exactly how a French company says it buys outside work.
  "indépendant",
  "indépendante",
  "auto-entrepreneur",
  "micro-entrepreneur",
  "portage salarial",
  "sous-traitance",
  "sous-traitant",
  "prestataire",
  // Spanish
  "autónomo",
  "autónoma",
  "subcontratación",
  "subcontratista",
  "colaborador externo",
  // Italian
  "libero professionista",
  "liberi professionisti",
  "partita IVA",
  "collaboratore esterno",
  // Dutch — the Netherlands runs on ZZP, and no translation of the German
  // vocabulary would ever find it.
  "ZZP",
  "zzp'er",
  "zelfstandige",
  // Polish, Norwegian, Finnish, Czech, Estonian: the registers reach these
  // countries, so the signal has to as well. Deliberately NOT including bare
  // "B2B", which means contractor in a Polish job ad and business-to-business
  // in every English one — a term that means two things cannot be a signal.
  // Slavic languages inflect by REPLACING the ending, not by appending one, so
  // the three-letter tolerance that carries German cannot reach
  // `samozatrudnienia` from `samozatrudnienie`. These are stems, chosen long
  // enough that nothing else in the language starts with them.
  "samozatrudnieni",
  "podwykonawc",
  "frilans",
  "frilanser",
  "konsulent",
  "alihankinta",
  "ammatinharjoittaja",
  "OSVČ",
  "živnostní",
  "vabakutseline",
];

/**
 * The terms, compiled once, longest first, with room for a German case ending.
 *
 * Two things this has to get right at the same time, and they pull apart:
 *
 *   * German inflects. The careers page says "wir arbeiten mit FREIBERUFLERN",
 *     not "mit Freiberufler". Demanding a hard word boundary on the right finds
 *     none of them, and the signal reads as absent on exactly the sites that
 *     carry it.
 *   * German also compounds without limit. `Freelancerschutzgesetzgebung` in a
 *     blog post is not a company buying contract work, and a suffix-tolerant
 *     match that swallows it turns a legal-news mention into a lead.
 *
 * So: up to three trailing letters — enough for -n, -s, -e, -en, -ern, -innen —
 * and no more. A compound noun adds far more than three. Longest alternative
 * first, so `Freelancer:innen` wins over `Freelance` on the same span and the
 * mention is recorded once, at its full length.
 */
const FREELANCE_RE = new RegExp(
  `(?<!\\p{L})(?:${[...FREELANCE_TERMS]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\p{L}{0,3}(?!\\p{L})`,
  "giu",
);

export interface SignalInput {
  pages: readonly { record: PageRecord; text: string; html?: string }[];
  jobs: readonly JobPosting[];
  atsProviders: readonly string[];
  sitemapUrls?: number;
  lastContentAt?: string;
  siteReachable: boolean;
  /** The run's country, so the legal-identifier patterns match the right law. */
  countryCode?: string;
  /** Injectable clock, so `oldestOpenRoleDays` is testable and reproducible. */
  now?: string;
  /**
   * Case-insensitive substrings the CALLER cares about in a job title.
   *
   * The engine deliberately does not know what a developer is, or a nurse, or
   * a project manager. Encoding one brief in a general tool is the same mistake
   * as turning `--icp` into a number: it produces an authoritative-looking
   * count of something nobody agreed on. Absent means nobody said what to look
   * for, and `matchedRoles` stays unset rather than becoming a misleading zero.
   */
  roleFilter?: readonly string[];
}

/**
 * Every place a freelance term appears, verbatim, with the page it came from.
 *
 * Returns the matched term as the value and the line around it as the note, so
 * the gate can re-read the value and a human can judge the context. A term that
 * cannot be found in its own page again does not ship — same rule as a contact.
 */
export function extractFreelanceMentions(text: string, pageId: string): SourcedValue[] {
  const out: SourcedValue[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(FREELANCE_RE)) {
    const key = m[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const start = Math.max(0, m.index - 90);
    const line = text
      .slice(start, Math.min(text.length, m.index + m[0].length + 90))
      .replace(/\s+/g, " ")
      .trim();
    out.push({ value: m[0], from: pageId, lane: "web", note: line });
  }
  return out;
}

/** Days since the oldest posting that carries a date. Undefined when none do. */
function oldestRoleDays(jobs: readonly JobPosting[], now?: string): number | undefined {
  const stamps = jobs.map((j) => (j.postedAt ? Date.parse(j.postedAt) : Number.NaN)).filter((n) => Number.isFinite(n));
  if (!stamps.length) return undefined;
  const ref = now ? Date.parse(now) : Date.now();
  return Math.max(0, Math.floor((ref - Math.min(...stamps)) / 86_400_000));
}

/** Fold everything measured about a site into one record. */
export function buildSignals(input: SignalInput): Signals {
  const html = input.pages.map((p) => p.html ?? "").join("\n");
  const roles = new Set(input.pages.map((p) => p.record.role));
  const techFromJsonLd = new Set<string>();
  for (const page of input.pages) {
    if (!page.html) continue;
    for (const node of extractJsonLd(page.html)) {
      const type = (node as { "@type"?: unknown })?.["@type"];
      if (typeof type === "string") techFromJsonLd.add(`schema:${type}`);
    }
  }

  return {
    hasWebsite: input.pages.length > 0,
    siteReachable: input.siteReachable,
    pageCount: input.pages.length,
    lastContentAt: input.lastContentAt,
    sitemapUrls: input.sitemapUrls,
    // Hiring is asserted only when postings were actually read. A detected
    // board with no readable API leaves this undefined rather than false: "not
    // hiring" and "we could not look" are different facts.
    isHiring: input.atsProviders.length === 0 && !roles.has("careers") ? false : input.jobs.length > 0 || undefined,
    openRoles: input.jobs.length,
    matchedRoles: input.roleFilter?.length
      ? input.jobs.filter((j) => input.roleFilter!.some((t) => j.title.toLowerCase().includes(t.toLowerCase()))).length
      : undefined,
    roleFilter: input.roleFilter?.length ? [...input.roleFilter] : undefined,
    // A role open for a long time is a role the company cannot fill. That is
    // the closest thing to a measurable freelance opportunity a public source
    // carries — and it is a COUNT of days, not a conclusion about why.
    oldestOpenRoleDays: oldestRoleDays(input.jobs, input.now),
    // CAREERS ONLY, and that restriction is the signal.
    //
    // Measured on a Hamburg run before it was scoped: 48 mentions, every
    // sampled one a false positive. `externe Dienstleister` is what a privacy
    // policy calls a data processor; `Freiberufler` on a law firm's or tax
    // adviser's site names the CLIENTS it advises; `Freelancer` on a one-person
    // web studio's homepage describes the owner. The vocabulary was right and
    // the page was wrong, which is the worst kind of wrong here: it reads as
    // measured. On a careers page the same words are a company saying how it
    // staffs work, which is the only reading worth acting on.
    freelanceMentions: input.pages.filter((p) => p.record.role === "careers").flatMap((p) => extractFreelanceMentions(p.text, p.record.id)),
    atsProviders: [...input.atsProviders],
    cms: fingerprints(html, CMS_FINGERPRINTS)[0],
    analytics: fingerprints(html, ANALYTICS_FINGERPRINTS),
    techStack: [...new Set([...fingerprints(html, CMS_FINGERPRINTS).slice(1), ...techFromJsonLd])],
    hasPricingPage: roles.has("pricing"),
    hasEcommerce: ECOMMERCE_FINGERPRINTS.test(html),
    languages: extractLanguages(html),
    socialProfiles: [...new Set(input.pages.flatMap((p) => extractSocials(p.html ?? "", p.record.id).map((s) => s.value)))],
    legalIdOnSite: input.pages.map((p) => readLegalId(p.text, input.countryCode)).find(Boolean),
  };
}

/** Absolute, same-origin links from a page, for the tier-2 walk. */
export function sameOriginLinks(html: string, base: string): string[] {
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return [];
  }
  const out = new Set<string>();
  // The `#` is captured, not excluded. Excluding it from the character class
  // does not strip the fragment — it makes the whole href fail to match, so a
  // nav built on `/services#web` loses the link entirely rather than
  // deduplicating it. The fragment is dropped below, after parsing.
  for (const m of html.matchAll(/<a\b[^>]*\shref=["']([^"']+)["']/gi)) {
    const href = m[1]!.trim();
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.origin !== origin) continue;
      url.hash = "";
      out.add(url.href);
    } catch {
      // A malformed href is the page's problem, not ours.
    }
  }
  return [...out];
}

/** The engine's HTML-to-text, re-exported so callers need one import. */
export { htmlToText };
