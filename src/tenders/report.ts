// Deliverables for a tenders run: TENDERS.csv, tenders-ranked.json, REPORT.md, index.html.
//
// The report's first sentence is DERIVED from the lanes, as for a territory
// run: which sources answered, which were partial, and which countries this run
// could only see above the EU thresholds or not at all. There is no code path
// that writes "all tenders in X".
import { mdInline as md, mdLink } from "../markdown.js";
import { csvRow } from "../util.js";
import { tenderConnectorById } from "./index.js";
import type { TenderManifest } from "./run.js";
import type { Tender, TenderLane } from "./types.js";
import { rankTenders } from "./verdicts.js";

const COLUMNS = [
  "id",
  "decision",
  "fit",
  "status",
  "deadline",
  "country",
  "buyer",
  "title",
  "value",
  "currency",
  "cpv",
  "source",
  "coverage",
  "documents",
  "pages",
  "url",
  "why",
];

export function tendersCsv(tenders: readonly Tender[]): string {
  const rows = [csvRow(COLUMNS)];
  for (const t of rankTenders(tenders)) {
    rows.push(
      csvRow([
        t.id,
        t.verdict?.decision ?? "",
        t.verdict?.fit ?? "",
        t.status,
        t.deadline ?? "",
        t.country,
        t.buyer.name,
        t.title,
        t.value?.amount ?? "",
        t.value?.currency ?? "",
        t.cpv.join(" "),
        t.connectorId,
        t.coverage,
        t.documentsAccess,
        (t.pages ?? []).length,
        t.sourceUrl ?? "",
        t.verdict?.why ?? "",
      ]),
    );
  }
  return rows.join("\n") + "\n";
}

const COVERAGE_WORDS: Record<string, string> = {
  all: "national, every threshold",
  "above-threshold": "above the EU/GPA thresholds only",
  "below-threshold": "below the thresholds only",
  funded: "one funder's projects",
  web: "found by search and corroborated on the page",
};

export function coverageSentence(m: TenderManifest): string {
  const lanes = m.lanes as TenderLane[];
  const answered = lanes.filter((l) => l.returned > 0).map((l) => l.connectorId);
  const partial = lanes.filter((l) => l.truncated).map((l) => l.connectorId);
  const parts = [`${m.tenderCounts.kept} notice(s) kept from ${answered.length} source(s)${answered.length ? ` (${answered.join(", ")})` : ""}`];
  if (partial.length) parts.push(`PARTIAL: ${partial.join(", ")} stopped before the end of their answer`);
  const above = (m.gaps ?? []).filter((g) => g.coverage === "above-threshold").map((g) => g.country.toUpperCase());
  const none = (m.gaps ?? []).filter((g) => g.coverage === "none").map((g) => g.country.toUpperCase());
  if (above.length) parts.push(`${above.join(", ")}: above-threshold only — the national market below the EU thresholds is not in this run`);
  if (none.length) parts.push(`${none.join(", ")}: no API source — only the web lane can see these`);
  return `${parts.join(". ")}.`;
}

export function tendersReport(tenders: readonly Tender[], m: TenderManifest): string {
  // Titles, buyers, verdicts, deadlines and upstream reasons are text from
  // outside: every one goes through the escaper (markdown.ts), in a cell, a
  // bullet or a heading alike.
  const lines: string[] = [`# Tenders — ${md(m.slug)}`, ""];
  if (m.truncated)
    lines.push(
      "> ⚠ **This run is TRUNCATED.** At least one source stopped before the end of its answer; the lists below are what was read, not the market.",
      "",
    );
  lines.push(md(coverageSentence(m)), "");
  lines.push("## Coverage", "", "| Source | Coverage | Kinds | Returned | Of | Partial | Why |", "|---|---|---|---:|---:|---|---|");
  for (const l of m.lanes as TenderLane[]) {
    lines.push(
      `| ${md(l.connectorId)} | ${md(COVERAGE_WORDS[l.coverage ?? ""] ?? l.coverage ?? "")} | ${md((l.kinds ?? []).join(", "))} | ${l.returned} | ${l.total ?? "?"} | ${l.truncated ? "yes" : "no"} | ${md(l.reason ?? "")} |`,
    );
  }
  const ranked = rankTenders(tenders);
  const open = ranked.filter((t) => t.kind === "call" && t.status !== "closed" && t.status !== "cancelled");
  lines.push(
    "",
    `## Open calls (${open.length})`,
    "",
    "| Decision | Fit | Deadline | Country | Buyer | Title | Value | Source |",
    "|---|---|---|---|---|---|---:|---|",
  );
  for (const t of open.slice(0, 200)) {
    lines.push(
      `| ${md(t.verdict?.decision ?? "—")} | ${md(t.verdict?.fit ?? "—")} | ${md(t.deadline ?? "unknown — open it")} | ${md(t.country)} | ${md(t.buyer.name || "?")} | ${mdLink(t.title.slice(0, 90), t.sourceUrl)} | ${t.value ? md(`${Math.round(t.value.amount)} ${t.value.currency}${t.value.estimated ? " (est.)" : ""}`) : "—"} | ${md(t.connectorId)} |`,
    );
  }
  const go = ranked.filter((t) => t.verdict?.decision === "go");
  if (go.length) {
    lines.push("", "## Judged go", "");
    for (const t of go)
      lines.push(
        `- **${md(t.title)}** — ${md(t.buyer.name)}, deadline ${md(t.deadline ?? "?")}: ${md(t.verdict!.why)}${t.verdict!.blockers?.length ? ` Blockers: ${md(t.verdict!.blockers.join("; "))}.` : ""}`,
      );
  }
  const awards = ranked.filter((t) => t.kind === "award").length;
  if (awards) lines.push("", `${awards} award notice(s) are in this run — \`ultraprospect awards --run <dir>\` analyses them.`);
  if (m.notes.length) lines.push("", "## Notes", "", ...m.notes.map((n) => `- ${md(n)}`));
  lines.push("", "## Sources", "", ...m.licences.map((l) => `- ${l}`));
  return lines.join("\n") + "\n";
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A self-contained page: one table, sortable by clicking a header. No external asset. */
export function tendersHtml(tenders: readonly Tender[], m: TenderManifest): string {
  const rows = rankTenders(tenders)
    .map(
      (t) =>
        `<tr><td>${esc(t.verdict?.decision ?? "")}</td><td>${esc(t.verdict?.fit ?? "")}</td><td>${esc(t.status)}</td><td>${esc(t.deadline ?? "")}</td><td>${esc(t.country)}</td><td>${esc(t.buyer.name)}</td><td>${t.sourceUrl ? `<a href="${esc(t.sourceUrl)}" rel="noopener noreferrer">${esc(t.title)}</a>` : esc(t.title)}</td><td>${esc(t.value ? `${Math.round(t.value.amount)} ${t.value.currency}` : "")}</td><td>${esc(tenderConnectorById(t.connectorId)?.label ?? t.connectorId)}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tenders — ${esc(m.slug)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:2rem;color:#1b1b1b}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:.4rem .5rem;text-align:left;vertical-align:top}th{cursor:pointer;background:#f6f6f6;position:sticky;top:0}.warn{background:#fff4e5;border-left:4px solid #e69500;padding:.6rem 1rem;margin:1rem 0}</style></head><body>
<h1>Tenders — ${esc(m.slug)}</h1>
${m.truncated ? `<p class="warn"><strong>This run is truncated.</strong> At least one source stopped before the end of its answer.</p>` : ""}
<p>${esc(coverageSentence(m))}</p>
<table id="t"><thead><tr><th>Decision</th><th>Fit</th><th>Status</th><th>Deadline</th><th>Country</th><th>Buyer</th><th>Title</th><th>Value</th><th>Source</th></tr></thead><tbody>
${rows}
</tbody></table>
<p><small>${m.licences.map(esc).join(" · ")}</small></p>
<script>document.querySelectorAll("th").forEach((th,i)=>th.addEventListener("click",()=>{const b=document.querySelector("tbody");const r=[...b.rows];const d=th.dataset.d=th.dataset.d==="1"?"-1":"1";r.sort((x,y)=>x.cells[i].textContent.localeCompare(y.cells[i].textContent)*d);r.forEach(x=>b.appendChild(x))}))</script>
</body></html>
`;
}
