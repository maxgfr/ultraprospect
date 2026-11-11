// The tender sources that publish OCDS: the United Kingdom (twice), Australia
// and Germany. One file because the reading is shared (`ocds.ts`) and what
// differs is only how each publisher pages and what it chose to publish.
//
//   gb-fts               Find a Tender — UK notices ABOVE the thresholds.
//   gb-contracts-finder  Contracts Finder — English notices BELOW them, and
//                        awards. The two together are the UK market; either
//                        alone is half of it, and the lane says which half.
//   au-austender         AusTender — CONTRACT notices only. The API exposes no
//                        open approaches to market, measured: every release on
//                        2026-10-01 carried tag ["contract"]. So this source
//                        answers `awards` and never `tenders --status open`.
//   de-oeffentlichevergabe  The federal Bekanntmachungsservice's daily export:
//                        every eForms notice published in Germany that day, one
//                        OCDS release each, ~1 000 a day in a 1.8 MB zip.
//                        Measured: these releases carry NO tenderPeriod — no
//                        submission deadline at all. A German notice from here
//                        is "status unknown" until its TED copy (merged by
//                        procedure id) or its own page says otherwise.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awaitHostSlot, cacheDir, httpGet, httpJson } from "../engine.js";
import { politeUa } from "../net.js";
import { openZipMember, zipEntries } from "../zip.js";
import { packageToTenders, releaseToTender } from "./ocds.js";
import type { SearchOutcome, Tender, TenderConnector, TenderQuery } from "./types.js";
import { keepByQuery, today } from "./util.js";

async function getJson(url: string): Promise<{ ok: boolean; data?: any; error?: string; status?: number }> {
  await awaitHostSlot(url, 400);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 45_000, retries: 1, userAgent: politeUa(), maxBytes: 24 * 1024 * 1024 });
  return { ok: res.ok, data: res.data, error: res.error, status: res.status };
}

/** Walk an OCDS release-package API that pages through `links.next`. */
async function walkPackages(firstUrl: string, q: TenderQuery, toTenders: (pkg: any) => Tender[], label: string): Promise<SearchOutcome> {
  const out: Tender[] = [];
  let url: string | undefined = firstUrl;
  let read = 0;
  const budget = q.limit * 10;
  while (url && out.length < q.limit && read < budget) {
    const res = await getJson(url);
    if (!res.ok) return { tenders: out, truncated: true, reason: `${label} refused: ${res.error ?? `HTTP ${res.status}`}` };
    const page = toTenders(res.data);
    read += Array.isArray(res.data?.releases) ? res.data.releases.length : page.length;
    for (const t of page) if (keepByQuery(t, q) && out.length < q.limit) out.push(t);
    const next: unknown = res.data?.links?.next;
    if (typeof next !== "string" || next === url || page.length === 0) {
      url = undefined;
      break;
    }
    url = next;
  }
  const truncated = Boolean(url);
  return {
    tenders: out,
    truncated,
    reason: truncated ? `${label}: stopped after reading ${read} release(s) (--limit ${q.limit}); more pages exist` : undefined,
  };
}

const iso = (day: string | undefined, end = false) => (day ? `${day}T${end ? "23:59:59" : "00:00:00"}` : undefined);

// ── United Kingdom — Find a Tender ───────────────────────────────────────────
const FTS = "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages";
const ftsUrl = (release: any) => (release?.id ? `https://www.find-tender.service.gov.uk/Notice/${release.id}` : undefined);

export const gbFts: TenderConnector = {
  id: "gb-fts",
  countries: ["gb"],
  label: "United Kingdom — Find a Tender (OCDS)",
  licence: "Find a Tender: Crown copyright, Open Government Licence v3.0",
  docsUrl: "https://www.find-tender.service.gov.uk/apidocumentation",
  coverage: "above-threshold",
  kinds: ["call", "award", "prior"],
  availability: () => ({ available: true }),
  async search(q) {
    if (q.countries.length && !q.countries.includes("gb")) return { tenders: [], truncated: false };
    const p = new URLSearchParams({ limit: "100" });
    const stages = [...new Set(q.kinds.map((k) => (k === "award" ? "award" : k === "prior" ? "planning" : "tender")))];
    if (stages.length === 1) p.set("stages", stages[0]!);
    if (q.publishedFrom) p.set("updatedFrom", iso(q.publishedFrom)!);
    if (q.publishedTo) p.set("updatedTo", iso(q.publishedTo, true)!);
    return walkPackages(
      `${FTS}?${p}`,
      q,
      (pkg) => packageToTenders(pkg, { connectorId: "gb-fts", country: "gb", coverage: "above-threshold", sourceUrl: ftsUrl }),
      "Find a Tender",
    );
  },
  async canary() {
    const res = await getJson(`${FTS}?limit=5&stages=tender`);
    const ts = packageToTenders(res.data, { connectorId: "gb-fts", country: "gb", coverage: "above-threshold" });
    return [
      { name: "Find a Tender still serves OCDS release packages keyless", ok: res.ok && ts.length > 0, detail: res.error },
      { name: "Find a Tender still pages with links.next", ok: typeof res.data?.links?.next === "string" },
      { name: "Find a Tender tenders still carry a CPV classification", ok: ts.some((t) => t.cpv.length > 0) },
      { name: "Find a Tender tenders still carry tenderPeriod.endDate", ok: ts.some((t) => Boolean(t.deadline)) },
    ];
  },
  async probe() {
    const res = await getJson(`${FTS}?limit=1`);
    return { ok: res.ok, detail: res.ok ? "Find a Tender answered" : (res.error ?? `HTTP ${res.status}`) };
  },
};

// ── United Kingdom — Contracts Finder ────────────────────────────────────────
const CF = "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search";
export function cfUrl(release: any): string | undefined {
  const doc = [...(release?.tender?.documents ?? []), ...(release?.awards ?? []).flatMap((a: any) => a?.documents ?? [])].find(
    (d: any) => typeof d?.url === "string" && d.url.includes("contractsfinder.service.gov.uk/Notice/"),
  );
  if (doc) return doc.url;
  const m = String(release?.ocid ?? "").match(/^ocds-b5fd17-([0-9a-f-]{36})$/i);
  return m ? `https://www.contractsfinder.service.gov.uk/Notice/${m[1]}` : undefined;
}

export const gbContractsFinder: TenderConnector = {
  id: "gb-contracts-finder",
  countries: ["gb"],
  label: "United Kingdom — Contracts Finder (OCDS)",
  licence: "Contracts Finder: Crown copyright, Open Government Licence v3.0",
  docsUrl: "https://www.contractsfinder.service.gov.uk/apidocumentation",
  coverage: "below-threshold",
  kinds: ["call", "award"],
  availability: () => ({ available: true }),
  async search(q) {
    if (q.countries.length && !q.countries.includes("gb")) return { tenders: [], truncated: false };
    const p = new URLSearchParams({ limit: "100" });
    const stages = [...new Set(q.kinds.map((k) => (k === "award" ? "award" : "tender")))];
    if (stages.length === 1) p.set("stages", stages[0]!);
    if (q.publishedFrom) p.set("publishedFrom", iso(q.publishedFrom)!);
    if (q.publishedTo) p.set("publishedTo", iso(q.publishedTo, true)!);
    return walkPackages(
      `${CF}?${p}`,
      q,
      (pkg) => packageToTenders(pkg, { connectorId: "gb-contracts-finder", country: "gb", coverage: "below-threshold", sourceUrl: cfUrl }),
      "Contracts Finder",
    );
  },
  async canary() {
    const res = await getJson(`${CF}?limit=5`);
    const ts = packageToTenders(res.data, { connectorId: "gb-contracts-finder", country: "gb", coverage: "below-threshold", sourceUrl: cfUrl });
    return [
      { name: "Contracts Finder still serves OCDS keyless", ok: res.ok && ts.length > 0, detail: res.error },
      { name: "Contracts Finder notices still resolve to a Notice page", ok: ts.some((t) => Boolean(t.sourceUrl)) },
      {
        name: "Contracts Finder awards still name suppliers",
        ok: ts.some((t) => t.awards.some((a) => a.supplier.name)),
        inconclusive: !ts.some((t) => t.kind === "award"),
      },
    ];
  },
  async probe() {
    const res = await getJson(`${CF}?limit=1`);
    return { ok: res.ok, detail: res.ok ? "Contracts Finder answered" : (res.error ?? `HTTP ${res.status}`) };
  },
};

// ── Australia — AusTender ────────────────────────────────────────────────────
const AU = "https://api.tenders.gov.au/ocds/findByDates/contractPublished";

export const auAustender: TenderConnector = {
  id: "au-austender",
  countries: ["au"],
  label: "Australia — AusTender contract notices (OCDS)",
  licence: "AusTender: Commonwealth of Australia, CC BY 3.0 AU",
  docsUrl: "https://github.com/austender/austender-ocds-api",
  coverage: "all",
  kinds: ["award"],
  availability: () => ({ available: true }),
  async search(q) {
    if (q.countries.length && !q.countries.includes("au")) return { tenders: [], truncated: false };
    if (!q.kinds.includes("award")) {
      return {
        tenders: [],
        truncated: false,
        notes: ["AusTender publishes CONTRACT notices only through its API; open approaches to market are not exposed. Ask `awards`, not open calls."],
      };
    }
    const from = q.publishedFrom ?? today();
    const to = q.publishedTo ?? today();
    return walkPackages(
      `${AU}/${from}T00:00:00Z/${to}T23:59:59Z`,
      q,
      (pkg) => packageToTenders(pkg, { connectorId: "au-austender", country: "au", coverage: "all" }),
      "AusTender",
    );
  },
  async canary() {
    const day = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const res = await getJson(`${AU}/${day}T00:00:00Z/${day}T23:59:59Z`);
    const ts = packageToTenders(res.data, { connectorId: "au-austender", country: "au", coverage: "all" });
    return [
      { name: "AusTender OCDS still answers findByDates keyless", ok: res.ok && Array.isArray(res.data?.releases), detail: res.error },
      { name: "AusTender contracts still name a supplier", ok: ts.some((t) => t.awards.some((a) => a.supplier.name)), inconclusive: ts.length === 0 },
      {
        name: "AusTender suppliers still carry an ABN",
        ok: ts.some((t) => t.awards.some((a) => a.supplier.legalId?.includes("ABN"))),
        inconclusive: ts.length === 0,
      },
    ];
  },
  async probe() {
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await getJson(`${AU}/${day}T00:00:00Z/${day}T23:59:59Z`);
    return { ok: res.ok, detail: res.ok ? `AusTender answered (${res.data?.releases?.length ?? 0} contracts on ${day})` : (res.error ?? `HTTP ${res.status}`) };
  },
};

// ── Germany — Bekanntmachungsservice daily export ────────────────────────────
const DE = "https://oeffentlichevergabe.de/api/notice-exports";
/** Days a single query may download. Each is ~1.8 MB; the lane says when it stopped. */
export const DE_MAX_DAYS = 31;

async function readDeZip(path: string): Promise<{ ok: boolean; releases: any[]; error?: string }> {
  const releases: any[] = [];
  try {
    for (const entry of await zipEntries(path)) {
      if (!entry.name.endsWith(".json")) continue;
      const stream = await openZipMember(path, entry);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      try {
        const pkg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const r of pkg?.releases ?? []) releases.push(r);
      } catch {
        // One unreadable member is one missing notice, not a failed day.
      }
    }
  } catch (e) {
    return { ok: false, releases, error: (e as Error).message };
  }
  return { ok: true, releases };
}

/**
 * One day's export. A past day's export does not change, so a zip already in
 * the cache for a day before yesterday is read back instead of downloaded
 * again: a 30-day query re-run the next morning costs one download, not 31 of
 * ~1.8 MB each. Yesterday's is always fetched, the newest export being the one
 * that could still be replaced. A cached zip that does not read (a copy cut
 * short) is fetched again rather than trusted.
 */
async function deDay(day: string, opts: { reuse?: boolean } = {}): Promise<{ ok: boolean; releases: any[]; error?: string }> {
  const dir = join(cacheDir(), "tenders", "de");
  const path = join(dir, `${day}.zip`);
  if (opts.reuse && existsSync(path)) {
    const cached = await readDeZip(path);
    if (cached.ok) return cached;
  }
  const url = `${DE}?pubDay=${day}&format=ocds.zip`;
  await awaitHostSlot(url, 500);
  const res = await httpGet(url, { binary: true, timeoutMs: 60_000, retries: 1, userAgent: politeUa(), maxBytes: 64 * 1024 * 1024 });
  if (!res.ok || !res.bytes) return { ok: false, releases: [], error: res.error ?? `HTTP ${res.status}` };
  if (res.truncated) return { ok: false, releases: [], error: "the export exceeded the download cap" };
  mkdirSync(dir, { recursive: true });
  // Written aside and renamed, so an interrupted write never leaves a partial
  // zip under the name a later run would reuse.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, res.bytes);
  renameSync(tmp, path);
  return readDeZip(path);
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${to}T00:00:00Z`); d >= Date.parse(`${from}T00:00:00Z`); d -= 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

export const deOeffentlichevergabe: TenderConnector = {
  id: "de-oeffentlichevergabe",
  countries: ["de"],
  label: "Germany — oeffentlichevergabe.de daily notice export (OCDS)",
  licence: "Bekanntmachungsservice: Datenlizenz Deutschland – Namensnennung 2.0",
  docsUrl: "https://oeffentlichevergabe.de/documentation/swagger-ui/opendata/index.html",
  coverage: "all",
  kinds: ["call", "award", "prior", "modification"],
  availability: () => ({ available: true }),
  async search(q: TenderQuery): Promise<SearchOutcome> {
    if (q.countries.length && !q.countries.includes("de")) return { tenders: [], truncated: false };
    // Today's export does not exist yet: measured, it answers HTTP 400 until the
    // day is over. Asking for it would read as a failed day.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const to = q.publishedTo && q.publishedTo < yesterday ? q.publishedTo : yesterday;
    const from = q.publishedFrom ?? to;
    const days = daysBetween(from, to);
    const read = days.slice(0, DE_MAX_DAYS);
    const out: Tender[] = [];
    const notes: string[] = [];
    // A window that starts after the last day with an export (a query for
    // today only) downloads nothing, and an empty lane with no word reads as
    // "Germany published nothing".
    if (!days.length)
      notes.push(
        `oeffentlichevergabe.de: nothing was downloaded — the window starts ${from}, after ${to}, the newest day with an export (a day's export appears once the day is over).`,
      );
    let failed = 0;
    for (const day of read) {
      const res = await deDay(day, { reuse: day < yesterday });
      if (!res.ok) {
        failed += 1;
        notes.push(`oeffentlichevergabe.de: ${day} could not be read (${res.error}).`);
      }
      for (const r of res.releases) {
        const t = releaseToTender(r, { connectorId: "de-oeffentlichevergabe", country: "de", coverage: "all" });
        if (t) t.asOf = day;
        if (t && keepByQuery(t, q)) out.push(t);
      }
      if (out.length >= q.limit) break;
    }
    const truncated = days.length > read.length || failed > 0 || out.length >= q.limit;
    return {
      tenders: out.slice(0, q.limit),
      truncated,
      reason: truncated
        ? [
            days.length > read.length ? `only the latest ${DE_MAX_DAYS} of ${days.length} days were downloaded` : "",
            failed ? `${failed} day(s) failed` : "",
            out.length >= q.limit ? `stopped at --limit ${q.limit}` : "",
          ]
            .filter(Boolean)
            .join("; ")
        : undefined,
      notes,
    };
  },
  async canary() {
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await deDay(day);
    const ts = res.releases
      .map((r) => releaseToTender(r, { connectorId: "de-oeffentlichevergabe", country: "de", coverage: "all" }))
      .filter(Boolean) as Tender[];
    return [
      { name: "oeffentlichevergabe.de still publishes a keyless daily OCDS zip", ok: res.ok && res.releases.length > 0, detail: res.error },
      { name: "German notices still carry CPV", ok: ts.some((t) => t.cpv.length > 0) },
      { name: "German buyers still carry an identifier", ok: ts.some((t) => Boolean(t.buyer.legalId)) },
    ];
  },
  async probe() {
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await deDay(day);
    return { ok: res.ok, detail: res.ok ? `oeffentlichevergabe.de: ${res.releases.length} notices on ${day}` : (res.error ?? "no answer") };
  },
};
