// The gate.
//
// Everything upstream of this file is retrieval; this is the part that makes
// the output trustworthy. A language model writing prospect dossiers will
// produce fluent, specific, plausible text whether or not the pages said any of
// it — and the failure is invisible, because the wrong version reads exactly
// like the right one. So the claims are checked mechanically against what is on
// disk, and the run fails rather than being presented with a caveat.
//
// Four errors and a set of warnings. The errors are the ones where a human
// reading the output could not possibly tell:
//
//   1. A [P#] that does not resolve to a stored page.
//   2. A factual sentence with no citation and no [M] marker.
//   3. A CONTACT that does not appear verbatim in the page it claims to come
//      from. This is the one that matters most: an invented email is the single
//      most damaging thing this tool could emit, because it will be sent to.
//   4. A dossier for a place that is not in the run.
//
// Warnings cover coverage and staleness — things a reader can see for
// themselves once told.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Place, RunManifest } from "./types.js";
import { foldAccents } from "./util.js";

export interface Finding {
  level: "error" | "warning";
  rule: string;
  where: string;
  message: string;
}

export interface CheckReport {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  counts: { dossiers: number; citations: number; contacts: number; places: number };
}

/**
 * `[P12]`, and `[M]` for a sentence the writer owns.
 *
 * A FACTORY, not a shared constant. A global regex carries `lastIndex` between
 * calls: `.test()` leaves it advanced on a match, and `String.matchAll` copies
 * `lastIndex` into the clone it iterates with. Sharing one instance therefore
 * made the second dossier in a run start scanning from wherever the first
 * dossier's last match ended — silently skipping its early citations, so an
 * unresolved id went unreported and a properly cited line was flagged as
 * uncited. A gate that quietly stops checking is worse than no gate.
 */
const citationRe = () => /\[P(\d+)\]/g;
const MODEL_MARK = /\[M\]/;

/**
 * Lines that are structure rather than assertion.
 *
 * A heading, a bullet's label, a table separator, a fenced block: none of these
 * make a factual claim, and demanding a citation on them would train whoever
 * writes the dossier to sprinkle ids to silence the gate — which is worse than
 * no gate, because the ids would stop meaning anything.
 */
function isStructural(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return true;
  if (t.startsWith("#") || t.startsWith(">") || t.startsWith("|") || t.startsWith("```")) return true;
  if (/^[-*_]{3,}$/.test(t)) return true;
  // A short bullet is a label ("**Contacts.**"), not a claim.
  if (/^[-*]\s*\*\*[^*]+\*\*:?\s*$/.test(t)) return true;
  if (t.length < 40) return true;
  return false;
}

/** Does this line assert something about the world? */
function isFactual(line: string): boolean {
  if (isStructural(line)) return false;
  // A line that is only a URL or a path is a reference, not a claim.
  if (/^\s*[-*]?\s*https?:\/\/\S+\s*$/.test(line)) return false;
  return true;
}

/**
 * Compare contacts the way a human would read them, not byte for byte.
 *
 * A phone number is stored normalised (`0143283007`) and written on the page as
 * `01.43.28.30.07`. Both sides get the same treatment here — accents folded,
 * case dropped, whitespace and separator punctuation removed — so the
 * comparison is about the VALUE rather than about its formatting. Anything
 * looser than this (a substring of digits, say) would start matching a phone
 * number against a SIRET.
 */
function normalizeForSearch(s: string): string {
  return foldAccents(s)
    .toLowerCase()
    .replace(/[\s.()-]/g, "");
}

export interface CheckInput {
  runDir: string;
  places: readonly Place[];
  manifest: RunManifest;
}

export function runCheck(input: CheckInput): CheckReport {
  const { runDir, places, manifest } = input;
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const err = (rule: string, where: string, message: string) => errors.push({ level: "error", rule, where, message });
  const warn = (rule: string, where: string, message: string) => warnings.push({ level: "warning", rule, where, message });

  // Every page id the run actually holds, with its text, read once.
  const pageText = new Map<string, string>();
  const pageOwner = new Map<string, string>();
  for (const place of places) {
    const dir = join(runDir, "pages", place.id.replace(/[^a-zA-Z0-9._-]/g, "_"));
    for (const id of place.pages) {
      const file = join(dir, `${id}.md`);
      pageOwner.set(id, place.id);
      if (existsSync(file)) pageText.set(id, readFileSync(file, "utf8"));
    }
  }

  // ---- Rule 3: no contact that was not observed ------------------------------
  //
  // Run over places rather than over dossiers, because the CSV is generated
  // from places and would carry a fabricated address even if no dossier ever
  // mentioned it.
  let contacts = 0;
  for (const place of places) {
    const items = [
      ...place.contacts.emails.map((c) => ({ ...c, kind: "email" })),
      ...place.contacts.phones.map((c) => ({ ...c, kind: "phone" })),
      ...place.contacts.people.map((c) => ({ ...c, kind: "person" })),
    ];
    for (const item of items) {
      contacts++;
      // Open-data lanes carry their own provenance and are not on disk as pages.
      if (item.lane === "sirene" || item.lane === "osm" || item.from === "osm" || item.from === "sirene") continue;
      const text = pageText.get(item.from);
      if (!text) {
        err(
          "contact-unsourced",
          `${place.id} · ${item.kind} ${item.value}`,
          `claims to come from ${item.from}, which is not a stored page in this run. A contact that cannot be re-read was not observed.`,
        );
        continue;
      }
      if (!normalizeForSearch(text).includes(normalizeForSearch(item.value))) {
        err(
          "contact-not-on-page",
          `${place.id} · ${item.kind} ${item.value}`,
          `does not appear in ${item.from}. Either it was constructed, or the page changed since it was read — both mean it must not ship.`,
        );
      }
    }
  }

  // ---- Dossiers ---------------------------------------------------------------
  const dossierDir = join(runDir, "dossiers");
  const files = existsSync(dossierDir) ? readdirSync(dossierDir).filter((f) => f.endsWith(".md")) : [];
  const byDossierName = new Map(places.map((p) => [`${p.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`, p]));
  let citations = 0;

  for (const file of files) {
    const rel = join("dossiers", file);
    const place = byDossierName.get(basename(file));
    if (!place) {
      err(
        "dossier-orphan",
        rel,
        `no place in places.json maps to this filename. A dossier must be named after its place id (\`dossier --id <id>\` prints the exact path); as written it describes a company this run does not contain.`,
      );
      continue;
    }
    const text = readFileSync(join(dossierDir, file), "utf8");
    const owned = new Set(place.pages);

    // Rule 1: every citation resolves, and belongs to THIS place.
    for (const m of text.matchAll(citationRe())) {
      citations++;
      const id = `P${m[1]}`;
      if (!pageText.has(id)) {
        err(
          "citation-unresolved",
          `${rel} · ${id}`,
          `no stored page has this id. check re-opens every citation, so this one was invented or the page was deleted.`,
        );
      } else if (!owned.has(id)) {
        err(
          "citation-foreign",
          `${rel} · ${id}`,
          `belongs to ${pageOwner.get(id)}, not to ${place.id}. A dossier may only cite pages fetched for its own company.`,
        );
      }
    }

    // Rule 2: every factual line is cited, or owned with [M].
    const lines = text.split("\n");
    let inFence = false;
    for (const [i, line] of lines.entries()) {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence || !isFactual(line)) continue;
      if (citationRe().test(line) || MODEL_MARK.test(line)) continue;
      err("claim-uncited", `${rel}:${i + 1}`, `a factual sentence with no [P#] and no [M]: "${line.trim().slice(0, 90)}"`);
    }
  }

  // ---- Warnings ---------------------------------------------------------------
  if (manifest.truncated) {
    warn("run-truncated", "manifest.json", "this run does not cover the whole territory; anything written from it must say so in its first sentence.");
  }
  const withSite = places.filter((p) => p.website?.confidence === "corroborated").length;
  const enriched = places.filter((p) => p.signals).length;
  if (files.length === 0) warn("no-dossiers", "dossiers/", "no dossier has been written yet; only the mechanical rules were checked.");
  if (withSite > 0 && enriched < withSite) {
    warn("coverage-enrichment", "places.json", `${withSite} place(s) have a corroborated site but only ${enriched} were enriched.`);
  }
  for (const place of places) {
    if (place.signals?.siteReachable === false)
      warn("site-unreachable", place.id, `${place.website?.url ?? "the site"} could not be fetched; its row rests on open data alone.`);
    if (place.website?.confidence === "unverified") {
      warn("website-unverified", place.id, `${place.website.url} was fetched but corroborated nothing. It is a candidate, not the company's site.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: { dossiers: files.length, citations, contacts, places: places.length },
  };
}

/** Human-readable rendering of a report. */
export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  for (const f of [...report.errors, ...report.warnings]) {
    lines.push(`  ${f.level === "error" ? "FAIL" : "warn"}  ${f.rule.padEnd(22)} ${f.where}`);
    lines.push(`        ${f.message}`);
  }
  lines.push("");
  lines.push(
    `  ${report.counts.places} place(s) · ${report.counts.dossiers} dossier(s) · ${report.counts.citations} citation(s) · ${report.counts.contacts} contact(s) checked`,
  );
  lines.push(report.ok ? "  check: ok" : `  check: ${report.errors.length} error(s)`);
  return lines.join("\n");
}
