// CLI wrappers for the tender commands: parse flags, call the core, print.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, jsonLine, UsageError } from "../engine.js";
import { formatReport } from "../check.js";
import { clampInt } from "../util.js";
import {
  applyVerdictsToRun,
  bidPacket,
  checkTenderRun,
  foldWeb,
  readTenderNotice,
  renderTenderRun,
  runAwards,
  startTenders,
  TenderUsageError,
  watchTenderRuns,
  writeWebTodo,
} from "./commands.js";
import { emitTenderOrchestration } from "./orchestrate.js";
import { PROFILE_TEMPLATE } from "./profile.js";
import { readTenders, resolveTenderRun } from "./run.js";
import type { WebHit } from "./web.js";

export interface Io {
  out(s: string): void;
  say(s: string): void;
}

const list = (raw: string | undefined): string[] | undefined => {
  const items = raw
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
};

function readJson(value: string, what: string): unknown {
  const raw = value === "-" ? readFileSync(0, "utf8") : readFileSync(value, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

function usage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TenderUsageError) throw new UsageError(e.message);
    throw e;
  }
}

async function usageAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TenderUsageError) throw new UsageError(e.message);
    throw e;
  }
}

const STATUSES = ["open", "awarded", "all"] as const;

export async function cmdTenders(values: Record<string, string>, bools: ReadonlySet<string>, io: Io, defaultOut: string): Promise<number> {
  if (bools.has("template")) {
    io.out(JSON.stringify(PROFILE_TEMPLATE, null, 2));
    io.say("tenders: fill this in, save it as profile.json, then: ultraprospect tenders --profile profile.json");
    return EXIT_OK;
  }

  // Follow-ups on an existing run: the web lane and the verdicts.
  if (values.run) {
    const runDir = resolveTenderRun(values.run);
    if (bools.has("queries")) {
      const todo = writeWebTodo(runDir, { countries: list(values.country) });
      if (bools.has("json")) io.out(jsonLine(todo));
      else for (const item of todo.items) for (const q of item.queries) io.out(q);
      io.say("");
      if (!todo.items.length) {
        io.say("tenders: no country needs the web lane — every one asked for has a national API source here.");
        io.say("  To search one anyway: --country it,es --queries. Terms come from the profile's keywords for that language.");
        return EXIT_OK;
      }
      io.say(`tenders: ${todo.items.length} market(s) to search by hand: ${todo.items.map((i) => `${i.country} (${i.lang})`).join(", ")}`);
      io.say(`  worklist: ${join(runDir, "WEB.todo.json")}`);
      io.say("  Run your own web search per query, in that market's language. Pool every hit:");
      io.say('  [{"url": "…", "title": "…", "snippet": "…", "country": "it", "query": "…"}]');
      io.say(`next: ultraprospect tenders --run ${runDir} --web-results hits.json`);
      io.say(`  or fan it out: ultraprospect orchestrate --run ${runDir} --phase web`);
      return EXIT_OK;
    }
    if (values["web-results"] || bools.has("engine-search")) {
      let hits: WebHit[] | undefined;
      if (values["web-results"]) {
        const parsed = readJson(values["web-results"], "--web-results") as any;
        hits = Array.isArray(parsed) ? parsed : (parsed?.hits ?? []);
      }
      const r = await foldWeb(runDir, {
        hits,
        engineSearch: bools.has("engine-search"),
        limit: values.limit ? clampInt(values.limit, 1, 10_000, 200) : undefined,
        onProgress: io.say,
      });
      if (bools.has("json")) io.out(jsonLine({ run: runDir, kept: r.tenders.length, fetched: r.fetched, rejected: r.rejected, unreadable: r.unreadable }));
      for (const n of r.notes) io.say(`  ${n}`);
      io.say(`tenders: web lane kept ${r.tenders.length} of ${r.fetched} fetched page(s); ${r.rejected.length} rejected, ${r.unreadable.length} unreadable.`);
      io.say(`next: ultraprospect orchestrate --run ${runDir} --phase qualify`);
      return r.tenders.length || !r.fetched ? EXIT_OK : EXIT_FAILURE;
    }
    if (values.apply) {
      const o = applyVerdictsToRun(runDir, readJson(values.apply, "--apply"));
      if (bools.has("json")) io.out(jsonLine(o));
      io.say(`tenders: ${o.applied} verdict(s) folded, ${o.merged} look-alike pair(s) merged.`);
      if (o.unknown.length) io.say(`  unknown id(s), ignored: ${o.unknown.join(", ")}`);
      if (o.invalid.length) io.say(`  malformed verdict(s) — need decision go|maybe|no-go, fit strong|possible|weak|no, and why: ${o.invalid.join(", ")}`);
      if (o.expired.length) io.say(`  REFUSED — "go" on a call whose deadline has passed: ${o.expired.join(", ")}`);
      io.say(`next: ultraprospect tender --run ${runDir} --id <a go> --documents`);
      return o.unknown.length || o.invalid.length || o.expired.length ? EXIT_FAILURE : EXIT_OK;
    }
    throw new UsageError("tenders --run needs one of --queries, --web-results, --engine-search or --apply");
  }

  const status = (values.status ?? "open") as (typeof STATUSES)[number];
  if (!STATUSES.includes(status)) throw new UsageError(`--status must be one of ${STATUSES.join(", ")}`);
  if (values.match && values.match !== "any" && values.match !== "all") throw new UsageError("--match must be any or all");
  const r = await usageAsync(() =>
    startTenders({
      out: values.out ?? defaultOut,
      countries: list(values.country),
      cpv: list(values.cpv),
      keywords: list(values.keywords),
      profilePath: values.profile,
      since: values.since,
      status,
      sources: list(values.source),
      minValue: values["min-value"] ? clampInt(values["min-value"], 0, 1e12, 0) : undefined,
      limit: values.limit ? clampInt(values.limit, 1, 10_000, 200) : undefined,
      match: values.match as "any" | "all" | undefined,
      fixture: values.fixture,
      record: values.record,
      onProgress: io.say,
    }),
  );
  const m = r.manifest;
  if (bools.has("json")) io.out(jsonLine({ run: r.runDir, counts: m.tenderCounts, truncated: m.truncated, gaps: m.gaps, lanes: m.lanes }));
  else io.out(r.runDir);
  io.say("");
  io.say(`  found        ${m.tenderCounts.found}`);
  io.say(
    `  kept         ${m.tenderCounts.kept}  (${m.tenderCounts.mergedDuplicates} duplicate(s) merged by procedure id, ${m.tenderCounts.pairs} look-alike pair(s) left to judge)`,
  );
  io.say(`  open calls   ${m.tenderCounts.open}`);
  if (m.truncated) io.say("  ⚠ TRUNCATED — at least one source stopped short; the report leads with it.");
  for (const g of m.gaps)
    io.say(
      `  gap: ${g.country.toUpperCase()} — ${g.coverage === "none" ? "no API source; the web lane is the only way in" : "above-threshold only; the national market below is not here"}`,
    );
  for (const p of r.profileProblems) io.say(`  profile: ${p}`);
  io.say("");
  if (m.gaps.length) io.say(`next: ultraprospect tenders --run ${r.runDir} --queries      # the web lane for the gaps`);
  io.say(`next: ultraprospect orchestrate --run ${r.runDir} --phase qualify`);
  return EXIT_OK;
}

export async function cmdTender(values: Record<string, string>, bools: ReadonlySet<string>, io: Io): Promise<number> {
  if (!values.run) throw new UsageError("tender needs --run <dir>");
  const runDir = resolveTenderRun(values.run);
  if (!values.id) {
    const tenders = readTenders(runDir).filter((t) => t.kind === "call");
    if (bools.has("json")) io.out(jsonLine(tenders.map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, decision: t.verdict?.decision }))));
    else for (const t of tenders.slice(0, 60)) io.out(`${t.id}\t${t.deadline ?? "?"}\t${t.verdict?.decision ?? "-"}\t${t.title.slice(0, 80)}`);
    io.say(`next: ultraprospect tender --run ${runDir} --id <id> --documents`);
    return EXIT_OK;
  }
  const r = await usageAsync(() =>
    readTenderNotice(runDir, values.id!, {
      documents: bools.has("documents"),
      maxPages: values["max-pages"] ? clampInt(values["max-pages"], 1, 100, 12) : undefined,
    }),
  );
  if (bools.has("json")) io.out(jsonLine({ id: r.tender.id, pages: r.tender.pages, documentsAccess: r.tender.documentsAccess, note: r.note }));
  else for (const p of r.tender.pages ?? []) io.out(`${p.id}\t${p.role}\t${p.url}`);
  io.say("");
  io.say(`tender: ${(r.tender.pages ?? []).length} page(s) stored, ${r.documents} document(s) read; documents ${r.tender.documentsAccess}.`);
  if (r.note) io.say(`  ${r.note}`);
  io.say(`next: ultraprospect bid --run ${runDir} --id ${r.tender.id}`);
  return EXIT_OK;
}

export async function cmdBid(values: Record<string, string>, bools: ReadonlySet<string>, io: Io): Promise<number> {
  if (!values.run) throw new UsageError("bid needs --run <dir>");
  if (!values.id) throw new UsageError("bid needs --id <tender id>; `tender --run <dir>` lists them");
  const runDir = resolveTenderRun(values.run);
  const r = usage(() => bidPacket(runDir, values.id!, values.profile));
  if (bools.has("json")) io.out(jsonLine({ id: r.tender.id, dir: r.dir, packet: r.markdown }));
  else io.out(r.markdown);
  io.say("");
  io.say(`write RESPONSE.md and COMPLIANCE.md to ${r.dir}`);
  io.say(`next: ultraprospect check --run ${runDir}`);
  return EXIT_OK;
}

export async function cmdAwards(values: Record<string, string>, bools: ReadonlySet<string>, io: Io, defaultOut: string): Promise<number> {
  const r = await usageAsync(() =>
    runAwards({
      out: values.out ?? defaultOut,
      run: values.run ? resolveTenderRun(values.run) : undefined,
      countries: list(values.country),
      cpv: list(values.cpv),
      keywords: list(values.keywords),
      profilePath: values.profile,
      since: values.since,
      sources: list(values.source),
      limit: values.limit ? clampInt(values.limit, 1, 10_000, 500) : 500,
      buyer: values.buyer,
      horizonMonths: values.horizon ? clampInt(values.horizon, 1, 120, 24) : undefined,
      confirm: !bools.has("no-registry"),
      fixture: values.fixture,
      record: values.record,
      onProgress: io.say,
    }),
  );
  if (bools.has("json"))
    io.out(
      jsonLine({
        run: r.runDir,
        suppliers: r.analysis.suppliers.slice(0, 50),
        buyers: r.analysis.buyers.slice(0, 50),
        upcoming: r.analysis.upcoming,
        medians: r.analysis.medians,
        identities: r.identities,
      }),
    );
  else io.out(r.path);
  io.say("");
  io.say(`  ${r.analysis.rows.length} award row(s) · ${r.analysis.suppliers.length} supplier(s) · ${r.analysis.buyers.length} buyer(s)`);
  io.say(`  ${r.analysis.upcoming.length} contract(s) likely back on the market within the horizon (estimated from the notice's duration)`);
  io.say(`  ${r.analysis.withoutDuration} row(s) publish no duration — no window drawn, none guessed`);
  if (r.identities.length) io.say(`  ${r.identities.filter((i) => i.connectorId).length}/${r.identities.length} top winner(s) confirmed against a register`);
  return EXIT_OK;
}

// ── existing commands, on a tenders run ──────────────────────────────────────

export function tenderCheckCmd(runDir: string, bools: ReadonlySet<string>, io: Io): number {
  const report = checkTenderRun(runDir);
  if (bools.has("json")) io.out(jsonLine(report));
  else
    io.out(
      formatReport(report)
        .replace(/place\(s\)/, "notice(s)")
        .replace(/dossier\(s\)/, "bid(s)"),
    );
  if (!report.ok) {
    io.say("");
    io.say("check: the bids did not pass. Fix the findings above — do not submit or present them.");
    return EXIT_FAILURE;
  }
  io.say("");
  io.say(`next: ultraprospect render --run ${runDir}`);
  return EXIT_OK;
}

export function tenderRenderCmd(runDir: string, bools: ReadonlySet<string>, io: Io): number {
  const files = renderTenderRun(runDir);
  if (bools.has("json")) io.out(jsonLine({ run: runDir, files }));
  else for (const f of files) io.out(f);
  io.say(`next: open ${join(runDir, "index.html")}`);
  return EXIT_OK;
}

export function tenderWatchCmd(afterDir: string, beforeDir: string, bools: ReadonlySet<string>, io: Io): number {
  const { delta, path } = watchTenderRuns(afterDir, beforeDir);
  if (bools.has("json"))
    io.out(
      jsonLine({
        run: afterDir,
        since: beforeDir,
        appeared: delta.appeared.length,
        changed: delta.changed.length,
        closingSoon: delta.closingSoon.length,
        notReturned: delta.notReturned.length,
      }),
    );
  else io.out(path);
  io.say(
    `  ${delta.appeared.length} new · ${delta.closingSoon.length} closing within two weeks · ${delta.changed.length} changed · ${delta.notReturned.length} not returned`,
  );
  return EXIT_OK;
}

export function tenderOrchestrateCmd(runDir: string, engineAbs: string, values: Record<string, string>, bools: ReadonlySet<string>, io: Io): number {
  const result = emitTenderOrchestration(runDir, engineAbs, { phase: values.phase, eco: bools.has("eco") });
  if (bools.has("list") || bools.has("json")) {
    io.out(
      jsonLine({
        run: runDir,
        exitCode: result.exitCode,
        phases: result.phases.map((p) => ({ name: p.name, ready: p.ready, items: p.items, prerequisite: p.prerequisite })),
      }),
    );
  } else {
    for (const f of result.written) io.out(f);
    if (result.exitCode === 0)
      io.say(`next: dispatch one subagent per batch with ${join(runDir, "orchestration", "agents", "<role>.md")} — or work down RUNBOOK.md yourself (--eco).`);
  }
  for (const n of result.notices) io.say(`  ${n}`);
  for (const e of result.errors) io.say(`  ${e}`);
  return result.exitCode === EXIT_USAGE ? EXIT_USAGE : result.exitCode;
}
