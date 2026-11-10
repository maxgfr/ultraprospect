// Who wins what, at what price — and when it comes back.
//
// An award notice is history, and history is the best map of the market there
// is: the buyers who buy what you sell, how often, at what price, and from whom.
// It also says when a contract ENDS, because most award notices publish a
// duration ("4 YEAR", "48 MONTH" — measured on TED, Contracts Finder, PNCP).
// A contract that ends is a contract the buyer has to tender again.
//
// That last step is the one place this tool computes a date rather than reads
// one, so it is fenced:
//
// - a renewal window exists ONLY when the notice publishes a duration or an end
//   date. No duration, no window — never a sector-average guess;
// - it is labelled "estimated from the notice's duration" everywhere it is
//   printed, and `check` refuses a write-up that prints one without the label;
// - it is a window, not a date: the re-tender is usually published 6 to 12
//   months before the end, and options to extend can push it out by years.
//   The notice's own option clauses decide, and they are in its pages.
import { nameSimilarity, normalizeName } from "../util.js";
import type { Tender, TenderAward } from "./types.js";
import { dayOf } from "./util.js";

export const FORECAST_LABEL = "estimated from the notice's duration";

export interface AwardRow {
  tenderId: string;
  country: string;
  buyer: string;
  buyerId?: string;
  title: string;
  cpv: string[];
  supplier: string;
  supplierId?: string;
  supplierCountry?: string;
  size?: string;
  value?: number;
  currency?: string;
  awardedAt?: string;
  durationMonths?: number;
  endsAt?: string;
  /** When the buyer is likely to publish the re-tender. Only with a published duration or end. */
  retenderWindow?: { from: string; to: string; basis: string };
  sourceUrl?: string;
  connectorId: string;
}

function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  const whole = Math.trunc(months);
  d.setUTCMonth(d.getUTCMonth() + whole);
  return d.toISOString().slice(0, 10);
}

export function endOf(a: TenderAward): { endsAt?: string; basis?: string } {
  if (a.endDate) return { endsAt: dayOf(a.endDate), basis: "the contract end date the notice publishes" };
  const start = dayOf(a.date);
  if (start && a.durationMonths)
    return { endsAt: addMonths(start, a.durationMonths), basis: `award date + the ${a.durationMonths}-month duration the notice publishes` };
  return {};
}

export function awardRows(tenders: readonly Tender[]): AwardRow[] {
  const rows: AwardRow[] = [];
  for (const t of tenders) {
    if (t.kind !== "award") continue;
    for (const a of t.awards) {
      if (!a.supplier.name) continue;
      const { endsAt, basis } = endOf(a);
      rows.push({
        tenderId: t.id,
        country: t.country,
        buyer: t.buyer.name,
        buyerId: t.buyer.legalId,
        title: t.title,
        cpv: t.cpv,
        supplier: a.supplier.name,
        supplierId: a.supplier.legalId,
        supplierCountry: a.supplier.country,
        size: a.size,
        value: a.value?.amount ?? (t.awards.length === 1 ? t.value?.amount : undefined),
        currency: a.value?.currency ?? t.value?.currency,
        awardedAt: dayOf(a.date) ?? t.publishedAt,
        durationMonths: a.durationMonths,
        endsAt,
        retenderWindow: endsAt && basis ? { from: addMonths(endsAt, -12), to: addMonths(endsAt, -6), basis: `${basis}; ${FORECAST_LABEL}` } : undefined,
        sourceUrl: t.sourceUrl,
        connectorId: t.connectorId,
      });
    }
  }
  return rows;
}

/** The key two award rows share when they name the same supplier. Identifier first, never a fuzzy name. */
function supplierKey(r: AwardRow): string {
  if (r.supplierId) {
    const digits = r.supplierId.replace(/\s/g, "");
    // A French SIRET's first nine digits are the SIREN: one company, many sites.
    const siren = /^\d{14}$/.test(digits) && r.country === "fr" ? digits.slice(0, 9) : digits;
    return `id:${siren.toUpperCase()}`;
  }
  return `name:${r.country}:${normalizeName(r.supplier)}`;
}

export interface SupplierStat {
  key: string;
  name: string;
  legalId?: string;
  wins: number;
  total: number;
  currency?: string;
  buyers: string[];
  countries: string[];
  lastWin?: string;
  /** Rows identified only by name: a lead to confirm, not an identity. */
  byNameOnly: boolean;
  /** Distinct notices won — a framework of twelve lots is one win, not twelve. */
  notices: string[];
}

export interface BuyerStat {
  name: string;
  notices: string[];
  awards: number;
  total: number;
  currency?: string;
  suppliers: string[];
  lastAward?: string;
}

export interface AwardAnalysis {
  rows: AwardRow[];
  suppliers: SupplierStat[];
  buyers: BuyerStat[];
  /** Median contract value per currency, from rows that publish a value. */
  medians: Record<string, { median: number; n: number }>;
  /** Contracts whose re-tender window opens within the horizon, soonest first. */
  upcoming: AwardRow[];
  /** Award rows with no published duration: no window could be drawn. */
  withoutDuration: number;
  /** Name-only suppliers that look like an identified one — for the agent to confirm, never merged. */
  lookalikes: { a: string; b: string; score: number }[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function analyseAwards(tenders: readonly Tender[], opts: { horizonMonths?: number; now?: Date; ownLegalId?: string } = {}): AwardAnalysis {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const horizon = addMonths(today, opts.horizonMonths ?? 24);
  const rows = awardRows(tenders);

  const suppliers = new Map<string, SupplierStat>();
  for (const r of rows) {
    const key = supplierKey(r);
    const s = suppliers.get(key) ?? {
      key,
      name: r.supplier,
      legalId: r.supplierId,
      wins: 0,
      total: 0,
      currency: r.currency,
      buyers: [],
      countries: [],
      byNameOnly: !r.supplierId,
      notices: [],
    };
    const first = !s.notices.includes(r.tenderId);
    if (first) s.notices.push(r.tenderId);
    s.wins = s.notices.length;
    // The total's currency is that of the first award that HAS a value. Taken
    // from the supplier's first row regardless, a row with no published value
    // left it unset, and every later amount — euros, pounds — was then summed
    // into one number printed with no currency at all.
    if (first && r.value) {
      if (!s.total) s.currency = r.currency;
      if (s.currency === r.currency) s.total += r.value;
    }
    if (r.buyer && !s.buyers.includes(r.buyer)) s.buyers.push(r.buyer);
    if (!s.countries.includes(r.country)) s.countries.push(r.country);
    if (r.awardedAt && (!s.lastWin || r.awardedAt > s.lastWin)) s.lastWin = r.awardedAt;
    suppliers.set(key, s);
  }

  const buyers = new Map<string, BuyerStat>();
  for (const r of rows) {
    const key = `${r.country}:${normalizeName(r.buyer)}`;
    const b = buyers.get(key) ?? { name: r.buyer, awards: 0, total: 0, currency: r.currency, suppliers: [], lastAward: undefined, notices: [] };
    const firstForBuyer = !b.notices.includes(r.tenderId);
    if (firstForBuyer) b.notices.push(r.tenderId);
    b.awards = b.notices.length;
    if (firstForBuyer && r.value) {
      if (!b.total) b.currency = r.currency;
      if (b.currency === r.currency) b.total += r.value;
    }
    if (!b.suppliers.includes(r.supplier)) b.suppliers.push(r.supplier);
    if (r.awardedAt && (!b.lastAward || r.awardedAt > b.lastAward)) b.lastAward = r.awardedAt;
    buyers.set(key, b);
  }

  const byCurrency = new Map<string, number[]>();
  // One value per notice, not per supplier: a framework with four winners is one contract.
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.value || !r.currency || seen.has(r.tenderId)) continue;
    seen.add(r.tenderId);
    byCurrency.set(r.currency, [...(byCurrency.get(r.currency) ?? []), r.value]);
  }
  const medians = Object.fromEntries([...byCurrency].map(([c, xs]) => [c, { median: median(xs), n: xs.length }]));

  const upcoming = rows
    .filter((r) => r.retenderWindow && r.retenderWindow.to >= today && r.retenderWindow.from <= horizon)
    .sort((a, b) => a.retenderWindow!.from.localeCompare(b.retenderWindow!.from));

  const named = [...suppliers.values()];
  const lookalikes: AwardAnalysis["lookalikes"] = [];
  const nameOnly = named.filter((s) => s.byNameOnly);
  const identified = named.filter((s) => !s.byNameOnly);
  for (const a of nameOnly) {
    for (const b of identified) {
      const score = nameSimilarity(a.name, b.name);
      if (score >= 0.85) lookalikes.push({ a: a.name, b: `${b.name} (${b.legalId})`, score: Math.round(score * 100) / 100 });
    }
  }

  return {
    rows,
    suppliers: named.sort((a, b) => b.wins - a.wins || b.total - a.total),
    buyers: [...buyers.values()].sort((a, b) => b.awards - a.awards || b.total - a.total),
    medians,
    upcoming,
    withoutDuration: rows.filter((r) => !r.retenderWindow).length,
    lookalikes,
  };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");

export function awardsMarkdown(a: AwardAnalysis, opts: { truncated: boolean; gaps: string[]; title: string; top?: number }): string {
  const top = opts.top ?? 20;
  const lines: string[] = [`# Awards — ${opts.title}`, ""];
  if (opts.truncated)
    lines.push(
      "> ⚠ **This analysis is TRUNCATED**: at least one source stopped before the end of its answer. Rankings below are over what was read, not over the market.",
      "",
    );
  if (opts.gaps.length) lines.push(`> Coverage: ${opts.gaps.join("; ")}.`, "");
  lines.push(`${a.rows.length} award row(s) from ${new Set(a.rows.map((r) => r.tenderId)).size} notice(s).`, "");

  lines.push("## Who wins", "", "| Supplier | Identifier | Notices won | Total awarded | Buyers | Last win |", "|---|---|---:|---:|---:|---|");
  for (const s of a.suppliers.slice(0, top)) {
    lines.push(
      `| ${s.name} | ${s.legalId ?? "name only — confirm before use"} | ${s.wins} | ${s.total ? `${fmt(s.total)} ${s.currency ?? ""}` : "—"} | ${s.buyers.length} | ${s.lastWin ?? "—"} |`,
    );
  }
  lines.push("", "## Who buys", "", "| Buyer | Awards | Total awarded | Distinct suppliers | Last award |", "|---|---:|---:|---:|---|");
  for (const b of a.buyers.slice(0, top))
    lines.push(`| ${b.name} | ${b.awards} | ${b.total ? `${fmt(b.total)} ${b.currency ?? ""}` : "—"} | ${b.suppliers.length} | ${b.lastAward ?? "—"} |`);

  if (Object.keys(a.medians).length) {
    lines.push("", "## Contract values", "");
    for (const [c, m] of Object.entries(a.medians)) lines.push(`- median ${fmt(m.median)} ${c}, over ${m.n} notice(s) that publish a value`);
  }

  lines.push("", `## Coming back to market — ${FORECAST_LABEL}`, "");
  lines.push(
    "Each window is the award date plus the duration the notice publishes, less 6–12 months: when the buyer is likely to publish the re-tender. Options to extend can push it out; read the notice before planning on one.",
    "",
  );
  if (!a.upcoming.length) lines.push("No published duration puts a re-tender inside the horizon.");
  else {
    lines.push("| Window (estimated) | Buyer | Contract | Incumbent | Ends | Notice |", "|---|---|---|---|---|---|");
    for (const r of a.upcoming.slice(0, top * 2)) {
      lines.push(
        `| ${r.retenderWindow!.from} → ${r.retenderWindow!.to} | ${r.buyer} | ${r.title.slice(0, 80)} | ${r.supplier} | ${r.endsAt} | ${r.sourceUrl ? `[${r.tenderId}](${r.sourceUrl})` : r.tenderId} |`,
      );
    }
  }
  lines.push("", `${a.withoutDuration} award row(s) publish no duration: no window was drawn for them, and none is guessed.`);
  if (a.lookalikes.length) {
    lines.push("", "## Names to confirm", "", "These suppliers appear by name only and look like an identified one. They were NOT merged:", "");
    for (const l of a.lookalikes.slice(0, 30)) lines.push(`- "${l.a}" ↔ ${l.b} (${Math.round(l.score * 100)}% alike)`);
  }
  return lines.join("\n") + "\n";
}
