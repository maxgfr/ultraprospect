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

/** Path fragments that identify a page's job, in French and English. */
const ROLE_PATTERNS: { role: PageRole; re: RegExp }[] = [
  { role: "careers", re: /(?:^|\/)(?:careers?|jobs?|emplois?|recrutement|nous-rejoindre|rejoignez|join-us|hiring|carriere|carrières?)(?:\/|$|\.)/i },
  { role: "pricing", re: /(?:^|\/)(?:pricing|tarifs?|prix|nos-tarifs|abonnements?|plans?|devis)(?:\/|$|\.)/i },
  { role: "about", re: /(?:^|\/)(?:about|about-us|a-propos|à-propos|qui-sommes-nous|notre-histoire|entreprise|company)(?:\/|$|\.)/i },
  { role: "team", re: /(?:^|\/)(?:team|equipe|équipe|notre-equipe|people|staff|collaborateurs|direction)(?:\/|$|\.)/i },
  { role: "contact", re: /(?:^|\/)(?:contact|contactez-nous|nous-contacter|contact-us)(?:\/|$|\.)/i },
  {
    role: "legal",
    re: /(?:^|\/)(?:mentions-legales|mentions-légales|legal|legal-notice|impressum|cgv|cgu|conditions-generales|privacy|confidentialite)(?:\/|$|\.)/i,
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
 *   - share buttons: `facebook.com/sharer/...?u=<our own url>`;
 *   - the network's own furniture: login, privacy, developer pages.
 * A CSV column headed "social profiles" containing a video id is worse than an
 * empty one — somebody clicks it.
 */
const NOT_A_PROFILE =
  /\/(?:sharer|share|intent|embed|watch|shorts|login|signup|policies|privacy|legal|about|developers?|plugins?|tr\?id=)\b|\?(?:u|text|url)=/i;

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

/** A French SIREN/SIRET or an intra-community VAT number, published on the site. */
export function extractLegalId(text: string): string | undefined {
  const vat = /\bFR\s?[0-9A-Z]{2}\s?(\d{3})\s?(\d{3})\s?(\d{3})\b/i.exec(text);
  if (vat) return vat[0].replace(/\s+/g, "").toUpperCase();
  const siret = /\b(?:SIRET)\D{0,12}(\d[\d\s.]{12,17}\d)\b/i.exec(text);
  if (siret) return siret[1]!.replace(/\D/g, "");
  const siren = /\b(?:SIREN|RCS[^\d]{0,30})\D{0,6}(\d[\d\s.]{7,12}\d)\b/i.exec(text);
  if (siren) return siren[1]!.replace(/\D/g, "");
  return undefined;
}

/** Language codes the page declares, from `<html lang>` and hreflang links. */
export function extractLanguages(html: string): string[] {
  const langs = new Set<string>();
  const htmlLang = /<html[^>]*\slang=["']([a-z]{2})/i.exec(html);
  if (htmlLang) langs.add(htmlLang[1]!.toLowerCase());
  for (const m of html.matchAll(/hreflang=["']([a-z]{2})/gi)) langs.add(m[1]!.toLowerCase());
  return [...langs];
}

export interface SignalInput {
  pages: readonly { record: PageRecord; text: string; html?: string }[];
  jobs: readonly JobPosting[];
  atsProviders: readonly string[];
  sitemapUrls?: number;
  lastContentAt?: string;
  siteReachable: boolean;
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
    atsProviders: [...input.atsProviders],
    cms: fingerprints(html, CMS_FINGERPRINTS)[0],
    analytics: fingerprints(html, ANALYTICS_FINGERPRINTS),
    techStack: [...new Set([...fingerprints(html, CMS_FINGERPRINTS).slice(1), ...techFromJsonLd])],
    hasPricingPage: roles.has("pricing"),
    hasEcommerce: ECOMMERCE_FINGERPRINTS.test(html),
    languages: extractLanguages(html),
    socialProfiles: [...new Set(input.pages.flatMap((p) => extractSocials(p.html ?? "", p.record.id).map((s) => s.value)))],
    legalIdOnSite: input.pages.map((p) => extractLegalId(p.text)).find(Boolean),
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
