// The gate, for a bid.
//
// The territory gate asks: does every claim about a company point at a page
// that says it? A bid adds a second party. Claims about the BUYER's need must
// point at what the buyer published; claims about the BIDDER must point at the
// profile — and nothing else can back them. A reference no profile holds, a
// deadline that differs from the notice's, a "go" on a closed call: each is the
// kind of error a buyer finds, and finds fatal.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { citationRe, factualParagraphs, type CheckReport, type Finding } from "../check.js";
import { readPageText } from "../run.js";
import { FORECAST_LABEL } from "./awards.js";
import { bidDirFor } from "./bid.js";
import { type BidderProfile, profileCitations } from "./profile.js";
import type { TenderManifest } from "./run.js";
import type { Tender } from "./types.js";
import { dayOf, deadlinePassed } from "./util.js";

const PROFILE_CITE = /\[((?:R|C)\d+|profile\.[a-zA-Z0-9_.]+)\]/g;
const MODEL_MARK = /\[M\]/;
/** First-person claims, in the languages a bid is written in. */
const FIRST_PERSON = /\b(we|our|us|nous|notre|nos|wir|unser[e]?|nosotros|nuestr[oa]s?|noi|nostr[oaie]|wij|onze|my|nasz[aey]?)\b/i;
const CLAIM_SHAPE =
  /(\d|certif|iso\s?\d|référence|reference|referenz|référencé|years?|ans\b|jahre|años|clients?|kunden|staff|salariés|employees|mitarbeiter|turnover|chiffre d'affaires|umsatz)/i;
const DEADLINE_WORDS = /(deadline|date limite|closing date|angebotsfrist|frist|plazo|scadenza|termine|due date|remise des offres)/i;
const DATE = /(\d{4}-\d{2}-\d{2})|(\d{1,2})[./](\d{1,2})[./](\d{4})/g;
const RETENDER = /(re-?tender|renewal|renouvellement|reconduction|wiederausschreibung|neuausschreibung|renovaci[oó]n)/i;

export function profileFromRun(runDir: string): BidderProfile | undefined {
  const p = join(runDir, "profile.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BidderProfile;
  } catch {
    return undefined;
  }
}

function datesOn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(DATE)) out.push(m[1] ? m[1] : `${m[4]}-${m[3]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`);
  return out;
}

export function runTenderCheck(input: {
  runDir: string;
  tenders: readonly Tender[];
  manifest: TenderManifest;
  profile?: BidderProfile;
  now?: Date;
}): CheckReport {
  const { runDir, tenders, manifest } = input;
  const profile = input.profile ?? profileFromRun(runDir);
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const err = (rule: string, where: string, message: string) => errors.push({ level: "error", rule, where, message });
  const warn = (rule: string, where: string, message: string) => warnings.push({ level: "warning", rule, where, message });
  const cites = profileCitations(profile);
  let citations = 0;
  let bids = 0;

  const ownerOf = new Map<string, string>();
  for (const t of tenders) for (const p of t.pages ?? []) ownerOf.set(p.id, t.id);
  // `basename`, not a split on "/": bidDirFor builds its path with `join`, which
  // writes "bids\\<id>" on Windows. Split on a slash, that has no second part,
  // so every notice was filed under `undefined` and every bid directory in the
  // run was reported as an orphan.
  const byDir = new Map(tenders.map((t) => [basename(bidDirFor(t)), t]));

  // Verdicts first: a go on a closed call is refused wherever it sits.
  for (const t of tenders) {
    if (t.verdict?.decision === "go" && deadlinePassed(t.deadline, input.now)) {
      err("deadline-passed", t.id, `judged "go" but the published deadline ${t.deadline} has passed.`);
    }
    for (const c of t.verdict?.cites ?? []) {
      if (/^P\d+$/.test(c) && ownerOf.get(c) !== t.id)
        err("citation-unresolved", `${t.id} · verdict · ${c}`, "the verdict cites a page this notice does not own.");
      if (/^(R|C)\d+$|^profile\./.test(c) && !cites.has(c))
        err("reference-unknown", `${t.id} · verdict · ${c}`, "the verdict cites a profile entry that does not exist.");
    }
  }

  const bidsRoot = join(runDir, "bids");
  const dirs = existsSync(bidsRoot)
    ? readdirSync(bidsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  for (const dir of dirs) {
    const t = byDir.get(dir);
    if (!t) {
      err("bid-orphan", `bids/${dir}`, "this bid directory maps to no notice in tenders.json.");
      continue;
    }
    for (const file of ["RESPONSE.md", "COMPLIANCE.md"]) {
      const path = join(bidsRoot, dir, file);
      if (!existsSync(path)) {
        if (file === "COMPLIANCE.md") warn("compliance-missing", `bids/${dir}`, "no COMPLIANCE.md: the requirement-by-requirement check has not been written.");
        continue;
      }
      bids += file === "RESPONSE.md" ? 1 : 0;
      const rel = `bids/${dir}/${file}`;
      const text = readFileSync(path, "utf8");

      for (const m of text.matchAll(citationRe())) {
        citations++;
        const id = `P${m[1]}`;
        const owner = ownerOf.get(id);
        if (!owner) err("citation-unresolved", `${rel} · ${id}`, "no stored page has this id.");
        else if (owner !== t.id) err("citation-foreign", `${rel} · ${id}`, `belongs to ${owner}. A bid may only cite the pages of its own notice.`);
      }
      for (const m of text.matchAll(PROFILE_CITE)) {
        citations++;
        if (!profile) err("reference-unknown", `${rel} · ${m[1]}`, "cites the bidder's profile, but the run holds no profile.json.");
        else if (!cites.has(m[1]!))
          err(
            "reference-unknown",
            `${rel} · ${m[1]}`,
            "no such entry in profile.json. A reference, certification or figure the profile does not hold must not be claimed.",
          );
      }

      for (const unit of factualParagraphs(text)) {
        const hasPage = citationRe().test(unit.text);
        const hasProfile = new RegExp(PROFILE_CITE.source).test(unit.text);
        if (!hasPage && !hasProfile && !MODEL_MARK.test(unit.text)) {
          err("claim-uncited", `${rel}:${unit.line}`, `a factual paragraph with no [P#], no profile id and no [M]: "${unit.text.trim().slice(0, 90)}"`);
          continue;
        }
        // A claim about the bidder must rest on the profile, not on a page or an [M].
        if (FIRST_PERSON.test(unit.text) && CLAIM_SHAPE.test(unit.text) && !hasProfile && !MODEL_MARK.test(unit.text)) {
          err(
            "bid-claim-unsourced",
            `${rel}:${unit.line}`,
            `a claim about the bidder that cites no [R#], [C#] or [profile.…]: "${unit.text.trim().slice(0, 90)}"`,
          );
        }
      }

      if (file === "RESPONSE.md") {
        const day = dayOf(t.deadline);
        for (const [i, line] of text.split("\n").entries()) {
          if (!DEADLINE_WORDS.test(line)) continue;
          const dates = datesOn(line);
          if (!dates.length) continue;
          if (day && !dates.includes(day))
            err("deadline-mismatch", `${rel}:${i + 1}`, `states ${dates.join(", ")} as the deadline; the notice publishes ${t.deadline}.`);
          if (!day && !citationRe().test(line))
            err("deadline-mismatch", `${rel}:${i + 1}`, "states a deadline the notice record does not publish, without citing the page it was read on.");
        }
        if (deadlinePassed(t.deadline, input.now)) warn("deadline-passed", rel, `the deadline ${t.deadline} has passed; this draft cannot be submitted.`);
        if (!(t.pages ?? []).some((p) => p.role === "document")) {
          warn(
            "documents-not-read",
            rel,
            t.documentsAccess === "registration"
              ? "the DCE is behind a registration wall and was not read; the draft must say it rests on the notice alone."
              : "no procurement document was read for this notice; run `tender --documents`, or say the draft rests on the notice alone.",
          );
        }
        if (!(t.pages ?? []).length) err("citation-unresolved", rel, "this notice has no stored pages at all: run `tender --id` before drafting.");
      }

      // A renewal date printed without its basis reads as a fact.
      for (const [i, line] of text.split("\n").entries()) {
        if (
          RETENDER.test(line) &&
          datesOn(line).length &&
          !/(estimated|estimé|estimée|geschätzt|estimad|stimat)/i.test(line) &&
          !line.includes(FORECAST_LABEL)
        ) {
          err("award-forecast-unlabelled", `${rel}:${i + 1}`, `a re-tender date stated as a fact. It is ${FORECAST_LABEL} — say so on the same line.`);
        }
      }
    }
  }

  // Pages must still exist where the run says they are.
  for (const t of tenders)
    for (const p of t.pages ?? [])
      if (!readPageText(runDir, p.extract)) err("page-missing", `${t.id} · ${p.id}`, `${p.extract} is gone; a citation to it can no longer be re-read.`);

  if (manifest.truncated)
    warn("run-truncated", "manifest.json", "at least one source stopped short; anything written from this run must say so in its first sentence.");
  for (const g of manifest.gaps ?? []) {
    warn(
      "coverage-gap",
      g.country,
      g.coverage === "none"
        ? "no API source serves this country: only the web lane can see its market."
        : "only an above-threshold source served this country: contracts below the EU thresholds are not in this run.",
    );
  }
  if (!dirs.length) warn("no-bids", "bids/", "no bid has been drafted yet; only the verdicts and pages were checked.");

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: { dossiers: bids, citations, contacts: 0, legalIds: 0, places: tenders.length },
  };
}
