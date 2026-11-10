// `tender`: read one notice in full, and its procurement documents when they are public.
//
// Three kinds of page are stored, each citable as [P#]:
//
//   the RECORD   what the source's API said, normalised — always written, so a
//                bid can cite the deadline and the buyer even when no page of
//                the publisher's own renders without JavaScript;
//   the NOTICE   the publisher's own page for it (sourceUrl), when readable;
//   DOCUMENTS    the DCE: every PDF / office file linked from the documents
//                page, and every member of a ZIP archive — the shape most
//                French and German buyer platforms ship their DCE in.
//
// A buyer platform that asks for an account before it hands over the documents
// is recorded as `documentsAccess: "registration"`, with its URL, and the
// documents are NOT fetched. Getting past a registration wall on the user's
// behalf would be creating an identity with a contracting authority; that is
// the user's act, not this tool's. The packet says the criteria then come from
// the notice alone.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docFormatForUrl, extractDocument, extractPdf, httpGet, isNoWrite, writeArtifact } from "../engine.js";
import { politeUa } from "../net.js";
import { fetchPage, pageDirFor, type PageStore } from "../pages.js";
import type { PageRecord } from "../types.js";
import { readZipMember, zipEntries } from "../zip.js";
import type { Tender } from "./types.js";

const DOC_LINK = /href\s*=\s*["']([^"'#]+\.(?:pdf|docx?|odt|xlsx?|ods|zip|rtf)(?:\?[^"']*)?)["']/gi;
/** Words a page uses when it is a login or registration wall, across the markets served. */
//
// Measured on marches-publics.info (a COEUR ESSONNE call, 2026-11-02): "POUR
// RETIRER UN DCE, VOUS DEVEZ VOUS IDENTIFIER", then a password form and a
// "bordereau de retrait". The same page links a generic platform PDF, so the
// presence of a link proves nothing about access — relevance does.
const WALL =
  /(s['’]identifier|vous identifier|identifiez[- ]vous|créer un compte|cr[ée]er votre compte|bordereau de retrait|mot de passe|connexion requise|se connecter|anmelden|registrieren|passwort|login|log in|sign in|password|register to|inscripción|registrarse|contraseña|accedi|registrati|zaloguj|hasło|inloggen|registreren|wachtwoord)/i;

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * Is this document about THIS procedure?
 *
 * A buyer platform's landing page links its own help files ("depot-pli.pdf",
 * "guide-utilisateur.pdf") beside — or instead of — the DCE. Citing those as the
 * buyer's requirements would be citing the platform's manual. So a document is
 * kept only when its text names the notice, the buyer, or enough of the title.
 */
export function aboutThisProcedure(text: string, t: Tender): boolean {
  const ft = fold(text);
  if (t.noticeId && ft.includes(fold(t.noticeId))) return true;
  if (t.buyer.name && t.buyer.name.length >= 5 && ft.includes(fold(t.buyer.name))) return true;
  const words = [
    ...new Set(
      fold(t.title)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 6),
    ),
  ];
  const hits = words.filter((w) => ft.includes(w)).length;
  return words.length > 0 && hits >= Math.min(3, Math.ceil(words.length / 2));
}

export interface NoticeOutcome {
  pages: PageRecord[];
  documentsAccess: Tender["documentsAccess"];
  documentsNote?: string;
  documents: number;
}

/** The API record as a page: every fact the bid may need, under one citable id. */
export function recordMarkdown(t: Tender): string {
  const lines = [
    `## Notice record — ${t.title}`,
    "",
    `- source: ${t.connectorId} (${t.coverage})`,
    `- notice id: ${t.noticeId}`,
    `- kind: ${t.kind}; status: ${t.status}`,
    `- buyer: ${t.buyer.name || "(not given)"}${t.buyer.legalId ? ` — ${t.buyer.legalId}` : ""}${t.buyer.city ? `, ${t.buyer.city}` : ""} (${t.country})`,
    `- deadline: ${t.deadline ?? "NOT PUBLISHED in this record"}`,
    `- published: ${t.publishedAt ?? "?"}`,
    `- CPV: ${t.cpv.join(", ") || "none published"}`,
    `- nature: ${t.nature}; procedure: ${t.procedure ?? "?"}`,
    `- value: ${t.value ? `${t.value.amount} ${t.value.currency}${t.value.estimated ? " (estimated)" : ""}` : "not published"}`,
    `- place of performance: ${t.places.join(", ") || "?"}`,
    `- documents: ${t.documentsUrl ?? "no link in the record"}`,
    `- submission: ${t.submissionUrl ?? "?"}`,
    `- notice page: ${t.sourceUrl ?? "none — this source publishes no per-notice page"}`,
  ];
  if (t.criteria.length) {
    lines.push("", "### Award criteria, as published", "");
    for (const c of t.criteria) lines.push(`- ${c.name}${c.weight ? ` — ${c.weight}` : ""}`);
  }
  if (t.lots.length) {
    lines.push("", "### Lots", "");
    for (const l of t.lots) lines.push(`- ${l.id ?? "lot"}: ${l.title ?? "?"}${l.value ? ` — ${l.value.amount} ${l.value.currency}` : ""}`);
  }
  if (t.awards.length) {
    lines.push("", "### Awards", "");
    for (const a of t.awards)
      lines.push(
        `- ${a.supplier.name}${a.supplier.legalId ? ` (${a.supplier.legalId})` : ""}${a.value ? ` — ${a.value.amount} ${a.value.currency}` : ""}${a.date ? `, ${a.date}` : ""}${a.durationMonths ? `, ${a.durationMonths} months` : ""}`,
      );
  }
  if (t.description) lines.push("", "### Description", "", t.description);
  return lines.join("\n");
}

function storePage(
  runDir: string,
  t: Tender,
  store: PageStore,
  title: string,
  url: string,
  role: PageRecord["role"],
  text: string,
  extractor: string,
): PageRecord {
  const id = `P${store.next++}`;
  const dir = pageDirFor(t.id);
  const extract = join(dir, `${id}.md`);
  const fetchedAt = new Date().toISOString();
  const header = [`# ${id} — ${title}`, "", `- url: ${url}`, `- role: ${role}`, `- fetched: ${fetchedAt}`, `- extractor: ${extractor}`, "", "---", "", ""].join(
    "\n",
  );
  if (!isNoWrite()) mkdirSync(join(runDir, dir), { recursive: true });
  writeArtifact(join(runDir, extract), header + text + "\n");
  return { id, url, role, title, fetchedAt, extractor, chars: text.length, extract };
}

/** The most one archive member may inflate to. A tender's largest PDF is a few tens of megabytes. */
const MAX_ARCHIVE_MEMBER_BYTES = 128 * 1024 * 1024;

async function zipMembers(
  runDir: string,
  t: Tender,
  store: PageStore,
  url: string,
  bytes: Buffer,
  max: number,
): Promise<{ pages: PageRecord[]; note?: string }> {
  const scratch = join(tmpdir(), `ultraprospect-dce-${process.pid}-${Date.now()}.zip`);
  writeFileSync(scratch, bytes);
  const pages: PageRecord[] = [];
  let skipped = 0;
  let oversized = 0;
  try {
    for (const entry of await zipEntries(scratch)) {
      if (pages.length >= max) {
        skipped += 1;
        continue;
      }
      if (entry.name.endsWith("/")) continue;
      const lower = entry.name.toLowerCase();
      // A buyer's platform is not a trusted source of archives: one member is
      // held in memory at a time, and never more than this much of it.
      const buf = await readZipMember(scratch, entry, MAX_ARCHIVE_MEMBER_BYTES);
      if (!buf) {
        oversized += 1;
        continue;
      }
      let text = "";
      let via = "";
      if (lower.endsWith(".pdf")) {
        const r = await extractPdf(buf);
        text = r.text;
        via = `pdf:${r.via ?? "none"}`;
      } else if (/\.(txt|md|csv)$/.test(lower)) {
        text = buf.toString("utf8");
        via = "text";
      } else {
        const fmt = docFormatForUrl(lower);
        if (!fmt) {
          skipped += 1;
          continue;
        }
        const r = await extractDocument(buf, fmt);
        text = r.text;
        via = `doc:${r.via ?? "none"}`;
      }
      if (text.trim().length < 80) {
        skipped += 1;
        continue;
      }
      pages.push(storePage(runDir, t, store, entry.name, `${url}#${entry.name}`, "document", text.trim(), via));
    }
  } catch (e) {
    return { pages, note: `the archive could not be read: ${(e as Error).message}` };
  } finally {
    rmSync(scratch, { force: true });
  }
  const notes = [
    skipped ? `${skipped} archive member(s) not read (no extractable text, unsupported format, or past --max-pages)` : "",
    oversized ? `${oversized} archive member(s) not read because they inflate past ${MAX_ARCHIVE_MEMBER_BYTES / 1024 / 1024} MB` : "",
  ].filter(Boolean);
  return { pages, note: notes.length ? notes.join("; ") : undefined };
}

async function fetchDocument(
  runDir: string,
  t: Tender,
  store: PageStore,
  url: string,
  max: number,
): Promise<{ pages: PageRecord[]; texts?: string[]; note?: string }> {
  if (/\.zip(\?|$)/i.test(url)) {
    const res = await httpGet(url, { binary: true, timeoutMs: 90_000, retries: 1, userAgent: politeUa(), maxBytes: 80 * 1024 * 1024 });
    if (!res.ok || !res.bytes) return { pages: [], note: `${url}: ${res.error ?? `HTTP ${res.status}`}` };
    if (res.truncated) return { pages: [], note: `${url}: archive larger than the download cap` };
    return zipMembers(runDir, t, store, url, res.bytes, max);
  }
  const r = await fetchPage(runDir, t.id, url, "document", store);
  return r.ok ? { pages: [r.page.record], texts: [r.page.text] } : { pages: [], note: `${url}: ${r.reason}` };
}

export async function readNotice(runDir: string, t: Tender, store: PageStore, opts: { documents?: boolean; maxPages?: number } = {}): Promise<NoticeOutcome> {
  const max = opts.maxPages ?? 12;
  const pages: PageRecord[] = [...(t.pages ?? [])];
  const notes: string[] = [];
  const have = (url: string) => pages.some((p) => p.url === url);

  if (!pages.some((p) => p.role === "notice" && p.extractor === "record")) {
    // Its own pseudo-URL, so the publisher's page at sourceUrl is still fetched.
    pages.push(storePage(runDir, t, store, `Notice record ${t.noticeId}`, `record:${t.id}`, "notice", recordMarkdown(t), "record"));
  }
  // A source may name a better rendering of the notice than its HTML page:
  // TED's PDF, in the buyer's language. Read it first, and the page only if not.
  const noticeDocument = typeof t.national?.noticeDocument === "string" ? t.national.noticeDocument : undefined;
  let haveNoticeText = false;
  if (noticeDocument && !have(noticeDocument)) {
    const d = await fetchPage(runDir, t.id, noticeDocument, "notice", store);
    if (d.ok) {
      pages.push(d.page.record);
      haveNoticeText = true;
    } else notes.push(`notice document ${noticeDocument}: ${d.reason}`);
  }
  if (!haveNoticeText && t.sourceUrl && !have(t.sourceUrl)) {
    const r = await fetchPage(runDir, t.id, t.sourceUrl, "notice", store);
    if (r.ok) pages.push(r.page.record);
    else notes.push(`notice page ${t.sourceUrl}: ${r.reason}`);
    const xml = t.national?.xml;
    if (!r.ok && typeof xml === "string" && !have(xml)) {
      const x = await fetchPage(runDir, t.id, xml, "notice", store);
      if (x.ok) pages.push(x.page.record);
    }
  }

  let access: Tender["documentsAccess"] = t.documentsAccess;
  let documents = 0;
  if (opts.documents && t.documentsUrl) {
    const url = t.documentsUrl;
    if (/\.(pdf|docx?|odt|xlsx?|zip|rtf)(\?|$)/i.test(url)) {
      const d = await fetchDocument(runDir, t, store, url, max);
      pages.push(...d.pages);
      documents += d.pages.length;
      if (d.note) notes.push(d.note);
    } else {
      const landing = await fetchPage(runDir, t.id, url, "document", store, { keepHtml: true });
      if (!landing.ok) {
        notes.push(`documents page ${url}: ${landing.reason}`);
      } else {
        pages.push(landing.page.record);
        const links = [...(landing.page.html ?? "").matchAll(DOC_LINK)]
          .map((m) => {
            try {
              return new URL(m[1]!.replace(/&amp;/g, "&"), landing.page.record.url).toString();
            } catch {
              return undefined;
            }
          })
          .filter((u): u is string => Boolean(u));
        let ignored = 0;
        for (const link of [...new Set(links)]) {
          if (documents >= max) break;
          const d = await fetchDocument(runDir, t, store, link, max - documents);
          d.pages.forEach((p, i) => {
            const text = d.texts?.[i];
            if (text !== undefined && !aboutThisProcedure(text, t)) {
              ignored += 1;
              return;
            }
            pages.push(p);
            documents += 1;
          });
          if (d.note) notes.push(d.note);
        }
        if (ignored) notes.push(`${ignored} linked file(s) ignored: they do not name this procedure (platform guides, other notices).`);
        if (!documents && WALL.test(landing.page.text)) {
          access = "registration";
          notes.push(`the buyer's platform asks for an account before handing over the documents: ${url}. Register there yourself; this tool does not.`);
        }
      }
    }
    if (documents > 0) access = "open";
  } else if (opts.documents && !t.documentsUrl) {
    notes.push("the notice record carries no documents link — read the notice page for where the DCE is published.");
  }

  return { pages, documentsAccess: access, documentsNote: notes.join(" ") || undefined, documents };
}
