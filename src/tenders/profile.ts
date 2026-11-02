// The bidder: what the user sells, and the only facts about them a bid may state.
//
// A territory run never needed this — it describes OTHER companies, from their
// own pages. A bid describes the USER's company, and the pages are no help:
// a past reference, a certification, a turnover figure are things only the
// user can say. The temptation they create is the oldest one in bid writing —
// a plausible reference, an ISO certificate everyone in the sector has, a round
// headcount — and a buyer that checks finds a false declaration, which in most
// procurement law is a ground for exclusion.
//
// So the profile is the bidder's evidence, citable like a page:
//
//   [R1] [R2] …       a reference (past contract) from `references`
//   [C1] …            a certification from `certifications`
//   [profile.<field>] any other field: offer, staff, turnover, capacity…
//
// and `check` refuses any claim about the bidder that cites nothing that
// exists here.
import { existsSync, readFileSync } from "node:fs";

export interface ProfileReference {
  id: string;
  client: string;
  year?: number | string;
  scope: string;
  value?: number;
  currency?: string;
  country?: string;
  /** A public URL that shows the reference, when there is one. */
  url?: string;
}

export interface ProfileCertification {
  id: string;
  name: string;
  issuer?: string;
  validUntil?: string;
}

export interface BidderProfile {
  company: { name: string; legalId?: string; country?: string; website?: string };
  /** What the company sells, in its own words. */
  offer: string;
  /** CPV prefixes the offer falls under. */
  cpv?: string[];
  /** Terms per language, ALREADY in that market's own words: { fr: [...], de: [...] }. */
  keywords?: Record<string, string[]>;
  countries?: string[];
  /** NUTS codes or regions the company will travel to. */
  regions?: string[];
  minValue?: number;
  maxValue?: number;
  currency?: string;
  capacity?: string;
  staff?: number;
  turnover?: { year: number | string; amount: number; currency?: string }[];
  references?: ProfileReference[];
  certifications?: ProfileCertification[];
  /** Anything else the user wants a bid to be able to cite. */
  [field: string]: unknown;
}

export const PROFILE_TEMPLATE: BidderProfile = {
  company: { name: "<legal name>", legalId: "<SIREN / company number / VAT>", country: "fr", website: "https://…" },
  offer: "<what you sell, in two or three sentences — the qualifier reads this against every notice>",
  cpv: ["72", "48"],
  keywords: { fr: ["<terme>"], en: ["<term>"] },
  countries: ["fr"],
  regions: [],
  minValue: 20000,
  maxValue: 2000000,
  currency: "EUR",
  capacity: "<how much you can deliver at once, team size available>",
  staff: 0,
  turnover: [{ year: 2025, amount: 0, currency: "EUR" }],
  references: [{ id: "R1", client: "<client>", year: 2025, scope: "<what you delivered>", value: 0, currency: "EUR", country: "fr" }],
  certifications: [{ id: "C1", name: "<ISO 27001, Qualiopi…>", issuer: "<body>", validUntil: "2027-12-31" }],
};

export interface ProfileProblem {
  field: string;
  message: string;
}

/** Validate a profile. Problems are returned, never thrown: the caller decides. */
export function validateProfile(raw: unknown): { profile?: BidderProfile; problems: ProfileProblem[] } {
  const problems: ProfileProblem[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problems: [{ field: "(root)", message: "a profile is a JSON object" }] };
  const p = raw as BidderProfile;
  if (!p.company?.name || p.company.name.startsWith("<")) problems.push({ field: "company.name", message: "the bidder's legal name is required" });
  if (!p.offer || p.offer.startsWith("<")) problems.push({ field: "offer", message: "describe what you sell — the qualifier judges every notice against it" });
  const ids = new Set<string>();
  for (const [list, prefix] of [
    [p.references ?? [], "R"],
    [p.certifications ?? [], "C"],
  ] as const) {
    for (const item of list as { id?: string }[]) {
      if (!item?.id || !new RegExp(`^${prefix}\\d+$`).test(item.id))
        problems.push({
          field: `${prefix === "R" ? "references" : "certifications"}[].id`,
          message: `ids look like ${prefix}1, ${prefix}2 — got ${JSON.stringify(item?.id)}`,
        });
      else if (ids.has(item.id)) problems.push({ field: item.id, message: "duplicate id" });
      else ids.add(item.id);
    }
  }
  for (const r of p.references ?? [])
    if (String(r.client ?? "").startsWith("<")) problems.push({ field: r.id, message: "a template placeholder is still in place" });
  return { profile: p, problems };
}

export function loadProfile(path: string): { profile?: BidderProfile; problems: ProfileProblem[] } {
  if (!existsSync(path)) return { problems: [{ field: "(file)", message: `no profile at ${path}` }] };
  try {
    return validateProfile(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    return { problems: [{ field: "(file)", message: `not valid JSON: ${(e as Error).message}` }] };
  }
}

/** Every citation id a profile can back: R#, C#, profile.<field>. */
export function profileCitations(p: BidderProfile | undefined): Set<string> {
  const out = new Set<string>();
  if (!p) return out;
  for (const r of p.references ?? []) if (r?.id) out.add(r.id);
  for (const c of p.certifications ?? []) if (c?.id) out.add(c.id);
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out.add(`profile.${k}`);
    if (k === "company" && typeof v === "object") for (const sub of Object.keys(v as object)) out.add(`profile.company.${sub}`);
  }
  return out;
}

/** The profile as the packet prints it: every citable fact under its id. */
export function profileMarkdown(p: BidderProfile): string {
  const lines: string[] = ["## The bidder (cite these ids for any claim about yourselves)", ""];
  lines.push(`- [profile.company] ${p.company.name}${p.company.legalId ? ` — ${p.company.legalId}` : ""}${p.company.country ? ` (${p.company.country})` : ""}`);
  lines.push(`- [profile.offer] ${p.offer}`);
  if (p.capacity) lines.push(`- [profile.capacity] ${p.capacity}`);
  if (p.staff) lines.push(`- [profile.staff] ${p.staff} staff`);
  for (const t of p.turnover ?? []) lines.push(`- [profile.turnover] ${t.year}: ${t.amount} ${t.currency ?? p.currency ?? ""}`.trimEnd());
  for (const r of p.references ?? [])
    lines.push(
      `- [${r.id}] ${r.client}${r.year ? `, ${r.year}` : ""}: ${r.scope}${r.value ? ` — ${r.value} ${r.currency ?? p.currency ?? ""}` : ""}${r.url ? ` (${r.url})` : ""}`,
    );
  for (const c of p.certifications ?? [])
    lines.push(`- [${c.id}] ${c.name}${c.issuer ? `, ${c.issuer}` : ""}${c.validUntil ? `, valid until ${c.validUntil}` : ""}`);
  const known = new Set([
    "company",
    "offer",
    "capacity",
    "staff",
    "turnover",
    "references",
    "certifications",
    "cpv",
    "keywords",
    "countries",
    "regions",
    "minValue",
    "maxValue",
    "currency",
  ]);
  for (const [k, v] of Object.entries(p)) if (!known.has(k) && v !== undefined) lines.push(`- [profile.${k}] ${typeof v === "string" ? v : JSON.stringify(v)}`);
  lines.push("");
  lines.push("Nothing outside this list may be claimed about the bidder. A missing reference or");
  lines.push("certification is a gap to name in COMPLIANCE.md, never one to fill.");
  return lines.join("\n");
}
