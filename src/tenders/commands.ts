// The tender commands' core, shared by the CLI and the MCP adapter.
//
// Every function here takes plain inputs and returns plain data; printing is
// the caller's. The CLI wraps them in `cli.ts`; the MCP adapter calls them
// directly — so a tool call and a command line can never disagree.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isNoWrite, readJsonSafe, writeArtifact } from "../engine.js";
import { mdInline as mdc, mdLink } from "../markdown.js";
import { newPageStore } from "../pages.js";
import { connectorsFor } from "../registry/index.js";
import type { LegalId, RegistryRecord } from "../registry/types.js";
import { writeJson, writeRunManifest } from "../run.js";
import { analyseAwards, awardsMarkdown, type AwardAnalysis } from "./awards.js";
import { bidDirFor, buildBidPacket } from "./bid.js";
import { profileFromRun, runTenderCheck } from "./check.js";
import { tenderConnectorsFor, TENDER_CONNECTORS } from "./index.js";
import { readNotice } from "./notice.js";
import { type BidderProfile, loadProfile } from "./profile.js";
import { tendersCsv, tendersHtml, tendersReport } from "./report.js";
import { emptyTenderManifest, newTenderRun, readTenders, recount, requireTenderManifest, tenderLicences, type TenderManifest, writeTenders } from "./run.js";
import { recordFixture, runTenderSearch } from "./search.js";
import type { NoticeKind, Tender, TenderLane, TenderQuery } from "./types.js";
import { EU27, sinceToDate, today } from "./util.js";
import { dedupeTenders, type DuplicatePair } from "./dedupe.js";
import { applyTenderVerdicts, buildTendersTodo, openPairs, rankTenders, type ApplyOutcome, type TendersTodo } from "./verdicts.js";
import { diffTenderRuns, tenderDeltaMarkdown, type TenderDelta } from "./watch.js";
import { buildWebTodo, engineSearchWeb, foldWebHits, type WebFoldOutcome, type WebHit, type WebTodo } from "./web.js";

export class TenderUsageError extends Error {}

export interface TendersInput {
  out: string;
  countries?: string[];
  cpv?: string[];
  keywords?: string[];
  profilePath?: string;
  since?: string;
  status?: "open" | "awarded" | "all";
  sources?: string[];
  minValue?: number;
  limit?: number;
  match?: "any" | "all";
  fixture?: string;
  record?: string;
  onProgress?: (line: string) => void;
}

/** "eu" expands to the 27; anything else is taken as an ISO alpha-2. */
export function expandCountries(raw: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const c of raw ?? []) {
    const v = c.trim().toLowerCase();
    if (!v) continue;
    if (v === "eu") out.push(...EU27);
    else if (v === "uk") out.push("gb");
    else out.push(v);
  }
  return [...new Set(out)];
}

function kindsFor(status: TendersInput["status"]): NoticeKind[] {
  if (status === "awarded") return ["award"];
  if (status === "all") return ["call", "award", "prior", "modification", "cancellation"];
  return ["call"];
}

export interface TendersResult {
  runDir: string;
  manifest: TenderManifest;
  tenders: Tender[];
  todo: ReturnType<typeof buildTendersTodo>;
  profileProblems: string[];
}

export async function startTenders(input: TendersInput): Promise<TendersResult> {
  let profile: BidderProfile | undefined;
  const profileProblems: string[] = [];
  if (input.profilePath) {
    const loaded = loadProfile(input.profilePath);
    profile = loaded.profile;
    for (const p of loaded.problems) profileProblems.push(`${p.field}: ${p.message}`);
  }
  const countries = expandCountries(input.countries?.length ? input.countries : profile?.countries);
  const cpv = input.cpv?.length ? input.cpv : (profile?.cpv ?? []);
  const keywords = input.keywords?.length ? input.keywords : Object.values(profile?.keywords ?? {}).flat();
  const status = input.status ?? "open";
  const from = sinceToDate(input.since ?? (status === "awarded" ? "2y" : "30d"));
  if (!from) throw new TenderUsageError(`--since "${input.since}" is not a duration (30d, 6m, 2y) or an ISO date`);
  if (!countries.length && !cpv.length && !keywords.length) {
    throw new TenderUsageError("tenders needs something to look for: --country, --cpv, --keywords, or a --profile that has them");
  }

  const query: TenderQuery = {
    countries,
    cpv,
    keywords,
    publishedFrom: from,
    publishedTo: today(),
    kinds: kindsFor(status),
    deadlineAfter: status === "open" ? today() : undefined,
    minValue: input.minValue,
    match: input.match,
    limit: input.limit ?? 200,
  };
  const { connectors, gaps } = tenderConnectorsFor(countries, { only: input.sources });
  if (input.sources?.length) {
    const unknown = input.sources.filter((s) => !TENDER_CONNECTORS.some((c) => c.id === s));
    if (unknown.length) throw new TenderUsageError(`unknown --source: ${unknown.join(", ")}. doctor lists them.`);
  }

  const label = countries.length ? countries.slice(0, 4).join("-") + (countries.length > 4 ? "-more" : "") : "world";
  const { dir } = newTenderRun(input.out, `${label}${cpv.length ? `-cpv${cpv.slice(0, 2).join("-")}` : ""}`);
  if (!isNoWrite()) mkdirSync(dir, { recursive: true });
  input.onProgress?.(`tenders: ${connectors.length} source(s) for ${countries.join(", ") || "every country they cover"}`);

  const res = await runTenderSearch(query, connectors, { fixture: input.fixture, onProgress: input.onProgress });
  if (input.record) recordFixture(input.record, res.raw, query);

  const manifest = emptyTenderManifest(label, { ...query, profile: input.profilePath ? "profile.json" : undefined, sources: connectors.map((c) => c.id) });
  manifest.lanes = res.lanes;
  manifest.truncated = res.lanes.some((l) => l.truncated && !String(l.reason ?? "").startsWith("not run:"));
  manifest.gaps = gaps;
  manifest.notes = [...res.notes, ...profileProblems.map((p) => `profile: ${p}`)];
  manifest.licences = tenderLicences(res.lanes);
  manifest.tenderCounts.found = res.found;
  manifest.tenderCounts.mergedDuplicates = res.merged.length;
  manifest.tenderCounts.pairs = res.pairs.length;
  recount(manifest, res.tenders);

  if (!isNoWrite()) mkdirSync(join(dir, "raw"), { recursive: true });
  for (const [id, out] of Object.entries(res.raw)) writeJson(dir, join("raw", `${id}.json`), out);
  writeTenders(dir, res.tenders);
  if (input.profilePath && profile) copyFileSync(input.profilePath, join(dir, "profile.json"));
  const todo = buildTendersTodo(res.tenders, res.pairs, profile ? "profile.json" : undefined);
  writeJson(dir, "TENDERS.todo.json", todo);
  writeRunManifest(dir, manifest);
  return { runDir: dir, manifest, tenders: res.tenders, todo, profileProblems };
}

/** The terms to search a market in: the profile's for that language, else the query's. */
function termsFor(manifest: TenderManifest, profile: BidderProfile | undefined) {
  return (lang: string): string[] => {
    const own = profile?.keywords?.[lang];
    if (own?.length) return own;
    return ((manifest.query.keywords as string[] | undefined) ?? []).slice(0, 4);
  };
}

/**
 * Which countries the web lane searches: every gap the APIs left, and every
 * country the user named explicitly with `--country` when nothing else serves it.
 */
export function webCountries(manifest: TenderManifest, extra: readonly string[] = []): string[] {
  return [...new Set([...(manifest.gaps ?? []).map((g) => g.country), ...expandCountries(extra)])];
}

export function writeWebTodo(runDir: string, opts: { countries?: string[]; perCountry?: number } = {}): WebTodo {
  const manifest = requireTenderManifest(runDir);
  const todo = buildWebTodo(webCountries(manifest, opts.countries), termsFor(manifest, profileFromRun(runDir)), opts.perCountry);
  writeJson(runDir, "WEB.todo.json", todo);
  return todo;
}

/** The look-alike pairs the run's worklist still holds. */
function pendingPairs(runDir: string): DuplicatePair[] {
  const todo = readJsonSafe(join(runDir, "TENDERS.todo.json")) as Partial<TendersTodo> | undefined;
  return Array.isArray(todo?.pairs) ? todo.pairs : [];
}

export async function foldWeb(
  runDir: string,
  input: { hits?: WebHit[]; engineSearch?: boolean; limit?: number; onProgress?: (line: string) => void },
): Promise<WebFoldOutcome & { notes: string[] }> {
  const manifest = requireTenderManifest(runDir);
  const tenders = readTenders(runDir);
  const todoPath = join(runDir, "WEB.todo.json");
  const todo: WebTodo = existsSync(todoPath) ? (JSON.parse(readFileSync(todoPath, "utf8")) as WebTodo) : writeWebTodo(runDir);
  const notes: string[] = [];
  let hits = input.hits ?? [];
  if (!hits.length && input.engineSearch) hits = await engineSearchWeb(todo, (n) => notes.push(n));
  const store = newPageStore(tenders.flatMap((t) => t.pages ?? []));
  const outcome = await foldWebHits(runDir, hits, todo, store, new Set(tenders.map((t) => t.id)), { limit: input.limit, onProgress: input.onProgress });
  // The web leads go through the same de-duplication as the API notices, so
  // one call found both ways is proposed as a pair instead of listed twice.
  // The pairs found at search time stay in the worklist: rewriting it with
  // nothing erased every look-alike nobody had judged yet.
  const d = dedupeTenders([...tenders, ...outcome.tenders]);
  const all = d.tenders;
  const fresh = new Set(outcome.tenders.map((t) => t.id));
  const pairs = openPairs([...pendingPairs(runDir), ...d.pairs.filter((p) => fresh.has(p.keep) || fresh.has(p.drop))], all);
  const lane: TenderLane = {
    lane: "tenders",
    connectorId: "web",
    coverage: "web",
    kinds: ["call"],
    requested: hits.length,
    returned: outcome.tenders.length,
    truncated: false,
    reason: `${hits.length} hit(s), ${outcome.fetched} fetched, ${outcome.tenders.length} corroborated, ${outcome.rejected.length} rejected, ${outcome.unreadable.length} unreadable`,
  };
  manifest.lanes = [...(manifest.lanes as TenderLane[]).filter((l) => l.connectorId !== "web"), lane];
  manifest.licences = tenderLicences(manifest.lanes as TenderLane[]);
  manifest.notes.push(...notes, `web lane: ${lane.reason}.`);
  manifest.tenderCounts.mergedDuplicates += d.merged.length;
  manifest.tenderCounts.pairs = pairs.length;
  recount(manifest, all);
  writeTenders(runDir, all);
  writeJson(runDir, "TENDERS.todo.json", buildTendersTodo(all, pairs, existsSync(join(runDir, "profile.json")) ? "profile.json" : undefined));
  writeRunManifest(runDir, manifest);
  return { ...outcome, notes };
}

export function applyVerdictsToRun(runDir: string, verdicts: unknown): ApplyOutcome {
  const manifest = requireTenderManifest(runDir);
  const { tenders, outcome } = applyTenderVerdicts(readTenders(runDir), verdicts);
  // Only the pairs a verdict settled, or whose notices are gone, leave the
  // worklist: a first partial answer must not erase the ones still unjudged.
  const pairs = openPairs(pendingPairs(runDir), tenders, outcome.decidedPairs);
  recount(manifest, tenders);
  manifest.tenderCounts.mergedDuplicates += outcome.merged;
  manifest.tenderCounts.pairs = pairs.length;
  manifest.notes.push(
    `tenders --apply: ${outcome.applied} verdict(s), ${outcome.merged} pair(s) merged${outcome.unknown.length ? `, ${outcome.unknown.length} unknown id(s)` : ""}${outcome.expired.length ? `, ${outcome.expired.length} go on an expired call refused` : ""}.`,
  );
  writeTenders(runDir, tenders);
  writeJson(runDir, "TENDERS.todo.json", buildTendersTodo(tenders, pairs, existsSync(join(runDir, "profile.json")) ? "profile.json" : undefined));
  writeRunManifest(runDir, manifest);
  return outcome;
}

export async function readTenderNotice(
  runDir: string,
  id: string,
  opts: { documents?: boolean; maxPages?: number } = {},
): Promise<{ tender: Tender; documents: number; note?: string }> {
  const manifest = requireTenderManifest(runDir);
  const tenders = readTenders(runDir);
  const t = tenders.find((x) => x.id === id || x.aliases.includes(id));
  if (!t) throw new TenderUsageError(`no notice "${id}" in ${runDir}`);
  const store = newPageStore(tenders.flatMap((x) => x.pages ?? []));
  const res = await readNotice(runDir, t, store, opts);
  t.pages = res.pages;
  t.documentsAccess = res.documentsAccess;
  t.documentsNote = res.documentsNote;
  recount(manifest, tenders);
  writeTenders(runDir, tenders);
  writeRunManifest(runDir, manifest);
  return { tender: t, documents: res.documents, note: res.documentsNote };
}

export function bidPacket(runDir: string, id: string, profilePath?: string): { markdown: string; dir: string; tender: Tender } {
  const manifest = requireTenderManifest(runDir);
  const t = readTenders(runDir).find((x) => x.id === id || x.aliases.includes(id));
  if (!t) throw new TenderUsageError(`no notice "${id}" in ${runDir}`);
  if (profilePath) {
    const loaded = loadProfile(profilePath);
    if (!loaded.profile) throw new TenderUsageError(`--profile: ${loaded.problems.map((p) => p.message).join("; ")}`);
    copyFileSync(profilePath, join(runDir, "profile.json"));
  }
  return { markdown: buildBidPacket(runDir, t, manifest, profileFromRun(runDir)), dir: join(runDir, bidDirFor(t)), tender: t };
}

export function checkTenderRun(runDir: string) {
  return runTenderCheck({ runDir, tenders: readTenders(runDir), manifest: requireTenderManifest(runDir) });
}

export function renderTenderRun(runDir: string, opts: { csvRaw?: boolean } = {}): string[] {
  const manifest = requireTenderManifest(runDir);
  const tenders = readTenders(runDir);
  manifest.tenderCounts.bids = existsSync(join(runDir, "bids")) ? readdirSync(join(runDir, "bids")).length : 0;
  const files = [
    ["TENDERS.csv", tendersCsv(tenders, { raw: opts.csvRaw })],
    ["tenders-ranked.json", JSON.stringify(rankTenders(tenders), null, 2) + "\n"],
    ["REPORT.md", tendersReport(tenders, manifest)],
    ["index.html", tendersHtml(tenders, manifest)],
  ] as const;
  for (const [name, content] of files) writeArtifact(join(runDir, name), content);
  return files.map(([name]) => join(runDir, name));
}

export function watchTenderRuns(afterDir: string, beforeDir: string): { delta: TenderDelta; path: string } {
  const delta = diffTenderRuns(readTenders(beforeDir), readTenders(afterDir));
  const path = join(afterDir, "DELTA.md");
  writeArtifact(path, tenderDeltaMarkdown(delta, requireTenderManifest(beforeDir), requireTenderManifest(afterDir)));
  return { delta, path };
}

/** Infer the kind of a supplier identifier the way the register connectors read it. */
export function legalIdOf(raw: string, country: string): LegalId | undefined {
  const v = raw.replace(/\s/g, "");
  if (country === "fr" && /^\d{14}$/.test(v)) return { kind: "siret", value: v, countryCode: "fr" };
  if (country === "fr" && /^\d{9}$/.test(v)) return { kind: "siren", value: v, countryCode: "fr" };
  if (country === "no" && /^\d{9}$/.test(v)) return { kind: "orgnr", value: v, countryCode: "no" };
  if (country === "gb" && /^[A-Z0-9]{8}$/i.test(v)) return { kind: "company-number", value: v.toUpperCase(), countryCode: "gb" };
  if (/^[A-Z]{2}[0-9A-Z]{6,}$/.test(v) && v.slice(0, 2).toLowerCase() === country) return { kind: "vat", value: v, countryCode: country };
  if (/^\d{6,}$/.test(v)) return { kind: "company-number", value: v, countryCode: country };
  return undefined;
}

export interface SupplierIdentity {
  supplier: string;
  legalId: string;
  connectorId?: string;
  legalName?: string;
  status?: string;
  sourceUrl?: string;
  activity?: string;
  employees?: number | string;
  refused?: string;
}

/**
 * Confirm the top identified winners against the country's register.
 *
 * The join that turns "SIRIS PROTECTION won four contracts" into a company with
 * a legal identity, a size and an activity code — a competitor to watch, or a
 * partner to call, and exactly the kind of row `scan` builds for a territory.
 */
export async function confirmSuppliers(analysis: AwardAnalysis, max = 15): Promise<SupplierIdentity[]> {
  const out: SupplierIdentity[] = [];
  for (const s of analysis.suppliers.filter((x) => x.legalId).slice(0, max)) {
    // The supplier's own country decides the register: a German winner of a
    // French contract is in the German register, not the French one. The
    // buyer's market is only the fallback when no notice says where it is.
    const country = s.country ?? s.countries[0] ?? "";
    const id = legalIdOf(s.legalId!, country);
    if (!id) {
      out.push({ supplier: s.name, legalId: s.legalId!, refused: "identifier shape not recognised for this country" });
      continue;
    }
    const { confirm } = connectorsFor(country);
    let rec: RegistryRecord | undefined;
    let via: string | undefined;
    for (const c of confirm) {
      if (!c.verifyId) continue;
      try {
        rec = await c.verifyId(id, {});
      } catch {
        rec = undefined;
      }
      if (rec) {
        via = c.id;
        break;
      }
    }
    out.push(
      rec
        ? {
            supplier: s.name,
            legalId: s.legalId!,
            connectorId: via,
            legalName: rec.legalName ?? rec.names[0],
            status: rec.status,
            sourceUrl: rec.sourceUrl,
            activity: rec.activityCode,
            employees: rec.employees ?? rec.sizeBand,
          }
        : {
            supplier: s.name,
            legalId: s.legalId!,
            refused: confirm.length ? "no register confirmed this identifier" : "no register connector serves this country",
          },
    );
  }
  return out;
}

export interface AwardsInput extends Omit<TendersInput, "status"> {
  run?: string;
  buyer?: string;
  horizonMonths?: number;
  confirm?: boolean;
}

export async function runAwards(input: AwardsInput): Promise<{ runDir: string; analysis: AwardAnalysis; identities: SupplierIdentity[]; path: string }> {
  let runDir = input.run;
  if (!runDir) {
    const started = await startTenders({ ...input, status: "awarded", since: input.since ?? "2y" });
    runDir = started.runDir;
  }
  const manifest = requireTenderManifest(runDir);
  let tenders = readTenders(runDir);
  if (input.buyer) {
    const b = input.buyer.toLowerCase();
    tenders = tenders.filter((t) => t.buyer.name.toLowerCase().includes(b));
  }
  const analysis = analyseAwards(tenders, { horizonMonths: input.horizonMonths });
  const identities = input.confirm === false ? [] : await confirmSuppliers(analysis);
  writeJson(runDir, "awards.json", { ...analysis, identities });
  let md = awardsMarkdown(analysis, {
    truncated: manifest.truncated,
    gaps: (manifest.gaps ?? []).map((g) => `${g.country.toUpperCase()} ${g.coverage === "none" ? "has no API source" : "is above-threshold only"}`),
    title: manifest.slug,
  });
  if (identities.length) {
    md +=
      "\n## Winners, confirmed against the register\n\n| Supplier | Identifier | Register | Legal name | Status | Activity | Size (register's own code or count) |\n|---|---|---|---|---|---|---|\n";
    for (const i of identities) {
      md += `| ${mdc(i.supplier)} | ${mdc(i.legalId)} | ${mdc(i.connectorId ?? "—")} | ${i.legalName ? mdLink(i.legalName, i.sourceUrl) : mdc(i.refused ?? "—")} | ${mdc(i.status ?? "—")} | ${mdc(i.activity ?? "—")} | ${mdc(i.employees ?? "—")} |\n`;
    }
  }
  const path = join(runDir, "AWARDS.md");
  writeArtifact(path, md);
  return { runDir, analysis, identities, path };
}
