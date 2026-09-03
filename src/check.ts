// The gate.
//
// Everything upstream of this file is retrieval; this is the part that makes
// the output trustworthy. A language model writing prospect dossiers will
// produce fluent, specific, plausible text whether or not the pages said any of
// it — and the failure is invisible, because the wrong version reads exactly
// like the right one. So the claims are checked mechanically against what is on
// disk, and the run fails rather than being presented with a caveat.
//
// Five errors and a set of warnings. The errors are the ones where a human
// reading the output could not possibly tell:
//
//   1. A [P#] that does not resolve to a stored page.
//   2. A factual sentence with no citation and no [M] marker.
//   3. A CONTACT that does not appear verbatim in the page it claims to come
//      from. This is the one that matters most: an invented email is the single
//      most damaging thing this tool could emit, because it will be sent to.
//   4. A dossier for a place that is not in the run.
//   5. A write-up that states a DATED register record without its date. Germany's
//      only open register export stopped in 2019, and "is registered at" reads
//      exactly like "was, as of 2018-07" to everyone downstream.
//
// Warnings cover coverage and staleness — things a reader can see for
// themselves once told.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { readJsonSafe } from "./engine.js";
import { poiContacts } from "./overpass.js";
import { connectorById } from "./registry/index.js";
import type { OsmPoi, Place, RunManifest } from "./types.js";
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
  counts: { dossiers: number; citations: number; contacts: number; legalIds: number; places: number };
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

  // OSM contacts cite the exact feature that declared them. Keep the recorded
  // features in memory so every contact can be re-read without reopening the
  // run artifact, just as fetched pages are loaded once below.
  const osmFeatures = new Map<string, OsmPoi>();
  for (const poi of (readJsonSafe(join(runDir, "osm.json")) as OsmPoi[] | undefined) ?? []) {
    osmFeatures.set(`${poi.osmType[0]}${poi.osmId}`, poi);
  }
  const stripLegalId = (value: string) => value.replace(/[\s.\-–—:/,\u00a0\u202f]/g, "").toLowerCase();
  const osmCarriesIdentifier = (from: string, value: string): boolean => {
    const match = /^osm:([nwr]\d+)$/.exec(from);
    const poi = match ? osmFeatures.get(match[1]!) : undefined;
    if (!poi) return false;
    return Object.entries(poi.tags)
      .filter(([tag]) => tag.startsWith("ref:"))
      .some(([, raw]) => stripLegalId(raw).includes(stripLegalId(value)));
  };

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
      // Web-discovered social profiles cite the profile URL itself and have no
      // stored page extract. OSM-declared profiles do have a re-readable source
      // in osm.json, so they belong in this gate with the other OSM contacts.
      ...place.contacts.socials.filter((c) => c.lane === "osm" || c.from === "osm" || c.from.startsWith("osm:")).map((c) => ({ ...c, kind: "social" })),
      ...place.contacts.people.map((c) => ({ ...c, kind: "person" })),
      // A term mention is a quote from the company's own page, and it is about
      // to be used as a reason to call them. Same treatment as a contact:
      // findable in the page it cites, or it does not ship.
      ...(place.signals?.termMentions ?? []).map((c) => ({ ...c, kind: "term mention" })),
    ];
    for (const item of items) {
      contacts++;
      if (item.lane === "registry" || item.from === "registry") continue;

      const claimsOsm = item.lane === "osm" || item.from === "osm" || item.from.startsWith("osm:");
      if (claimsOsm) {
        const match = /^osm:([nwr]\d+)$/.exec(item.from);
        const poi = match ? osmFeatures.get(match[1]!) : undefined;
        if (!poi) {
          err(
            "contact-unsourced",
            `${place.id} · ${item.kind} ${item.value}`,
            `claims to come from ${item.from}, which is not an OSM feature stored in this run's osm.json. A contact that cannot be re-read was not observed.`,
          );
          continue;
        }
        const declared = poiContacts(poi);
        const values = item.kind === "email" ? declared.emails : item.kind === "phone" ? declared.phones : item.kind === "social" ? declared.socials : [];
        if (!values.some((value) => value.value === item.value)) {
          err(
            "contact-not-on-page",
            `${place.id} · ${item.kind} ${item.value}`,
            `does not appear in the contact tags of ${item.from} stored in osm.json. Either it was constructed, or the OSM feature changed before this run was recorded — both mean it must not ship.`,
          );
        }
        continue;
      }

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

  // ---- Rule 4: a legal identifier must still be readable on the page it cites --
  //
  // `confirm` turns a registration number read off a company's own site into a
  // register identity, and that is the strongest evidence in a non-French run.
  // It is also the easiest to get silently wrong: a regex that drifts, a page
  // that changed, an identifier copied from the wrong company's Impressum. The
  // number must be findable in the stored extract, exactly as the run claims to
  // have read it, or the identity it produced rests on nothing.
  let legalIds = 0;
  for (const place of places) {
    for (const id of place.legalIds ?? []) {
      legalIds++;
      if (!id.from) {
        // No page id at all. Nothing to re-read, so nothing to trust.
        err(
          "legal-id-unsourced",
          `${place.id} · ${id.kind} ${id.value}`,
          "carries no page id, so it cannot be re-read. A registration nobody can check is not evidence.",
        );
        continue;
      }
      if (id.from.startsWith("osm:")) {
        const match = /^osm:([nwr]\d+)$/.exec(id.from);
        if (!match || !osmFeatures.has(match[1]!)) {
          err(
            "legal-id-unsourced",
            `${place.id} · ${id.kind} ${id.value}`,
            `claims to come from ${id.from}, which is not an OSM feature stored in this run's osm.json.`,
          );
        } else if (!osmCarriesIdentifier(id.from, id.value)) {
          err(
            "legal-id-not-on-page",
            `${place.id} · ${id.kind} ${id.value}`,
            `does not appear in the ref:* tags of ${id.from} stored in osm.json. Either it was misread, or the OSM feature changed before this run was recorded — both mean the identity built on it must not ship.`,
          );
        }
        continue;
      }
      const text = pageText.get(id.from);
      if (!text) {
        err("legal-id-unsourced", `${place.id} · ${id.kind} ${id.value}`, `claims to come from ${id.from}, which is not a stored page in this run.`);
        continue;
      }
      // Compared with separators stripped from both sides: a page writes
      // "DE 811 907 980" and the record holds "DE811907980", and neither
      // spelling is wrong.
      //
      // Both sides are stripped of the PUNCTUATION a register number is merely
      // presented with, because the value was normalised on the way in and the
      // page was not. A German Impressum writes "HRB: 77491" and no register
      // accepts a colon in a lookup, so the extractor is right to drop it and
      // this has to drop it too. Found the hard way: four genuine identities
      // failed this rule over a colon. A gate that rejects true evidence is not
      // strict, it is broken — people route around it, and then it stops
      // catching the fabricated ones it exists for.
      const haystack = stripLegalId(text);
      if (!haystack.includes(stripLegalId(id.value))) {
        err(
          "legal-id-not-on-page",
          `${place.id} · ${id.kind} ${id.value}`,
          `does not appear in ${id.from}. Either it was misread, or the page changed since — both mean the identity built on it must not ship.`,
        );
      }
    }
  }

  // A register identity that claims to come from a published number, with no
  // such number recorded, cannot be audited at all.
  for (const place of places) {
    const ev = place.registryEvidence;
    if (ev?.how !== "verified-id" && ev?.how !== "osm-identifier") continue;
    const legalId = ev.legalId ? (place.legalIds ?? []).find((id) => id.value === ev.legalId) : undefined;
    const connector = place.registry ? connectorById(place.registry.connectorId) : undefined;
    const registryCarriesIdentifier = Boolean(
      place.registry &&
        legalId &&
        connector?.osmRefKeys?.some((key) => {
          if (key.kind !== legalId.kind) return false;
          const raw = key.level === "establishment" ? place.registry?.establishmentId : place.registry?.id;
          return raw !== undefined && key.normalise(raw) === legalId.value;
        }),
    );
    const backed = Boolean(
      legalId &&
        (ev.how !== "osm-identifier" ||
          (ev.from?.startsWith("osm:") && legalId.from === ev.from && osmCarriesIdentifier(ev.from, legalId.value) && registryCarriesIdentifier)),
    );
    if (!backed) {
      err(
        "registry-evidence-unbacked",
        `${place.id}`,
        `says its register record was attached from a published identifier, but the cited source does not carry that identifier.`,
      );
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

    // ---- Rule 5: a dated register record may not be written as today's fact ---
    //
    // A record carrying `asOf` came out of a bulk snapshot, not from asking the
    // register. Germany's only open export stopped in 2019, so "is registered at
    // …" is a claim this run cannot support where "was, as of 2018-07" is exactly
    // what it holds. The two read identically to anyone downstream, which is the
    // whole reason this is a gate and not a note.
    //
    // Checked by DEMANDING THE DATE rather than by guessing at tense. Tense
    // detection over prose is unreliable and would either miss the real cases or
    // flag correct ones; requiring the date to appear is unambiguous, easy to
    // satisfy honestly, and impossible to satisfy dishonestly.
    const asOf = place.registry?.asOf;
    if (asOf) {
      const year = asOf.slice(0, 4);
      const month = asOf.slice(0, 7);
      const mentionsDate = text.includes(asOf) || text.includes(month) || (text.includes(year) && /as of|as at/i.test(text));
      if (!mentionsDate) {
        err(
          "dated-record-undated",
          rel,
          `the register record for this company is dated ${asOf} — it comes from a bulk snapshot, not from asking the register — and this write-up never says so. State the date beside the register facts ("registered at …, as of ${month}"), or the reader will take a ${year} filing for today's.`,
        );
      }
    }

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

    // Rule 2: every factual PARAGRAPH is cited, or owned with [M].
    //
    // Paragraph, not line. Markdown wraps, and a citation belongs at the end of
    // the thing it supports — so a four-line paragraph ending in [P1] is
    // properly cited, and flagging its first three lines is just punishing the
    // author for using a text width. Writing the first real dossier produced 13
    // of those against one genuinely-cited paragraph, and the only ways out
    // would have been one-line paragraphs or an id on every line: exactly the
    // id-sprinkling that makes a citation stop meaning anything.
    const lines = text.split("\n");
    let inFence = false;
    let start = 0;
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length === 0) return;
      const paragraph = buffer.join(" ");
      buffer = [];
      if (!isFactual(paragraph)) return;
      if (citationRe().test(paragraph) || MODEL_MARK.test(paragraph)) return;
      err("claim-uncited", `${rel}:${start + 1}`, `a factual paragraph with no [P#] and no [M]: "${paragraph.trim().slice(0, 90)}"`);
    };

    for (const [i, line] of lines.entries()) {
      if (line.trim().startsWith("```")) {
        flush();
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (line.trim() === "") {
        flush();
        continue;
      }
      // A heading, a table row or a rule closes the paragraph before it and is
      // structure in its own right.
      if (isStructural(line) && buffer.length === 0) continue;
      if (buffer.length === 0) start = i;
      buffer.push(line.trim());
    }
    flush();
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
    counts: { dossiers: files.length, citations, contacts, legalIds, places: places.length },
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
    `  ${report.counts.places} place(s) · ${report.counts.dossiers} dossier(s) · ${report.counts.citations} citation(s) · ${report.counts.contacts} contact(s) · ${report.counts.legalIds} registration(s) checked`,
  );
  lines.push(report.ok ? "  check: ok" : `  check: ${report.errors.length} error(s)`);
  return lines.join("\n");
}
