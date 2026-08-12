// Bulk open data, ingested once and read locally.
//
// Two of the registers this tool needs publish everything they have as one large
// file and nothing at all as a queryable API:
//
//   * Companies House's Free Company Data Product — 470 MB of zipped CSV, a new
//     snapshot every month, no key and no registration. It is the reason the
//     United Kingdom can be enumerated at all without a credential.
//   * OffeneRegister's German export — 260 MB of bzip2'd JSON Lines. Its SQL API
//     is gone (the Datasette answers 502), and the file is what remains.
//
// Neither belongs on a per-run path, so neither is on one. `ingest` fetches and
// indexes once into the cache; every query after that is local. The command says
// what it is about to download BEFORE downloading it, because a tool that quietly
// pulls half a gigabyte has misled somebody about what running it costs.
//
// THE LAYOUT IS TWO BUCKET SETS, NOT AN OFFSET INDEX.
//
// A locality index and an identifier index, each 256 shards of JSON Lines, keyed
// by a hash of the normalised key. A query reads exactly one shard — a few
// megabytes, one linear scan, no seeking. The obvious alternative, one data file
// plus a map of byte offsets, needs an index holding an entry per record: five
// million of them for Germany, tens of megabytes of JSON to parse before
// answering anything, and a seek per hit. Two flat passes over a small file beat
// that, and the code is short enough to be obviously correct.
//
// ONLY THE LOCALITY INDEX HOLDS RECORDS. The identifier index holds pointers —
// `{k: idKey, l: localityKey}` — and that asymmetry is not a micro-optimisation.
// The first version stored the full record in both, and because the German export
// is findable under two identifiers (court-qualified and bare), it wrote every
// record three times: MEASURED at 10.7 GB for one country. Pointers bring that to
// about a quarter of it, at the cost of a second small scan per lookup.
//
// Records are mapped to `RegistryRecord` AT INGEST TIME rather than stored raw,
// and stored WITHOUT fields derivable from the ones beside them. Both matter at
// five million rows: the mapper runs once per snapshot instead of once per query,
// and a record that repeats its own register number four times costs a gigabyte
// to say the same thing.
import { createReadStream, createWriteStream } from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { cacheDir, fnv1a64, slugify } from "./engine.js";
import { bunzip2Blocks } from "./bunzip2.js";
import { openZipMember, zipEntries } from "./zip.js";
import { politeUa } from "./net.js";
import { VERSION } from "./version.js";
import type { RegistryRecord } from "./registry/types.js";

/** 256 shards: small enough that one scan is cheap, few enough to list at a glance. */
const BUCKETS = 256;

export type SnapshotFormat = "jsonl.bz2" | "csv.zip";

/** One ingested row: the mapped record, plus every key it must be findable under. */
export interface SnapshotRow {
  record: RegistryRecord;
  /** The town the register files it under. Absent means it is only findable by id. */
  locality?: string;
  /** Identifiers a legal notice might publish. Normalised on the way in and out. */
  ids: string[];
}

export interface SnapshotSource {
  format: SnapshotFormat;
  /**
   * Candidate URLs, best first.
   *
   * A list rather than a string because a monthly product is not published on the
   * first of the month: Companies House says "within 5 working days of the
   * previous month end", so the current month's file 404s for up to a week and
   * the previous one is the right answer during it.
   */
  urls(now: Date): string[];
  /** The attribution that must travel with any record from this snapshot. */
  licence: string;
  /** The data's own vintage, where the export has one. A per-record `asOf` wins. */
  vintage?: string;
  /** Roughly what a download costs, for the sentence printed before it starts. */
  approxBytes: number;
  /** Roughly what the INDEX costs on disk, which is the larger of the two numbers. */
  approxDiskBytes?: number;
  /** Map one row — a parsed JSON object, or a CSV record keyed by column name. */
  parse(row: any): SnapshotRow | undefined;
}

export interface SnapshotMeta {
  connectorId: string;
  /**
   * The tool version that INDEXED this snapshot.
   *
   * Records are mapped at ingest time, so a fix to a connector's mapper does not
   * reach a cache that was built before it — the cache keeps answering with the
   * old mapping, silently and indefinitely. That is not hypothetical: a UK
   * administrative SIC code was being filed as a NACE section, and correcting the
   * mapper changed nothing for anyone who had already ingested. So the version is
   * stamped and `staleSnapshots()` names the ones that need re-ingesting.
   */
  toolVersion: string;
  sourceUrl: string;
  /** The upstream's own Last-Modified, which is the closest thing to a real vintage. */
  lastModified?: string;
  vintage?: string;
  licence: string;
  ingestedAt: string;
  rows: number;
  /** Rows the connector's own mapper rejected. A high number means the shape moved. */
  skipped: number;
  bytesOnDisk: number;
}

const root = () => join(cacheDir(), "snapshots");
const dir = (connectorId: string) => join(root(), connectorId);

/**
 * The key a locality or an identifier is filed under.
 *
 * `slugify` comes from the engine, so "Düsseldorf", "Duesseldorf " and
 * "DÜSSELDORF" land in one place, and a second normaliser cannot drift from the
 * first. Identifiers go through the same function on purpose: "HRB 150148" and
 * "hrb-150148" are one number written twice.
 */
export function snapshotKey(raw: string): string {
  return slugify(raw, { max: 120 });
}

function bucketOf(key: string): string {
  return (Number(fnv1a64(key) % BigInt(BUCKETS)) | 0).toString(16).padStart(2, "0");
}

export function snapshotMeta(connectorId: string): SnapshotMeta | undefined {
  const path = join(dir(connectorId), "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SnapshotMeta;
  } catch {
    return undefined;
  }
}

export function hasSnapshot(connectorId: string): boolean {
  return snapshotMeta(connectorId) !== undefined;
}

/** Every ingested snapshot, for `ingest --list`. */
export function listSnapshots(): SnapshotMeta[] {
  if (!existsSync(root())) return [];
  return readdirSync(root())
    .map((id) => snapshotMeta(id))
    .filter((m): m is SnapshotMeta => Boolean(m))
    .sort((a, b) => a.connectorId.localeCompare(b.connectorId));
}

function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const child = join(p, e.name);
      if (e.isDirectory()) walk(child);
      else total += statSync(child).size;
    }
  };
  walk(path);
  return total;
}

/** Lines of a stream, decoded as UTF-8 and split on newlines. */
async function* linesOf(stream: Readable): AsyncGenerator<string> {
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) yield line;
}

/**
 * A CSV row splitter that honours quotes, doubled quotes and embedded newlines.
 *
 * Companies House's CSV carries commas inside company names and quotes inside
 * addresses, so `split(",")` produces shifted columns — the failure that puts a
 * postcode in the SIC field on a few thousand rows out of five million and is
 * invisible in a spot check. Embedded newlines mean a RECORD can span lines,
 * which is why this yields records rather than mapping lines.
 */
export async function* csvRecords(stream: Readable): AsyncGenerator<string[]> {
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let pending = false;

  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (quoted) {
        if (c !== '"') {
          field += c;
          continue;
        }
        // A doubled quote is one literal quote; a lone one closes the field.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
        continue;
      }
      if (c === '"') {
        quoted = true;
        pending = true;
        continue;
      }
      if (c === ",") {
        row.push(field);
        field = "";
        pending = true;
        continue;
      }
      if (c === "\n" || c === "\r") {
        if (field.length || row.length || pending) {
          row.push(field);
          yield row;
          row = [];
          field = "";
          pending = false;
        }
        continue;
      }
      field += c;
      pending = true;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    yield row;
  }
}

/** Rows of the source, whatever it is packed in. */
async function* rowsOf(source: SnapshotSource, path: string): AsyncGenerator<any> {
  if (source.format === "jsonl.bz2") {
    // Read the compressed file whole (260 MB) and yield decompressed blocks: the
    // OUTPUT is the part that does not fit in memory, not the input.
    const compressed = readFileSync(path);
    let tail = "";
    for (const block of bunzip2Blocks(compressed)) {
      const text = tail + Buffer.from(block).toString("utf8");
      const parts = text.split("\n");
      tail = parts.pop() ?? "";
      for (const line of parts) {
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // A single unparseable line is counted as skipped by the caller's
          // mapper, never allowed to end the ingest.
          yield undefined;
        }
      }
    }
    if (tail.trim()) {
      try {
        yield JSON.parse(tail);
      } catch {
        yield undefined;
      }
    }
    return;
  }

  const entries = await zipEntries(path);
  const csv = entries.find((e) => e.name.toLowerCase().endsWith(".csv"));
  if (!csv) throw new Error(`no CSV member in ${path} (found: ${entries.map((e) => e.name).join(", ") || "nothing"})`);
  let header: string[] | undefined;
  for await (const row of csvRecords(await openZipMember(path, csv))) {
    if (!header) {
      // Companies House pads its header with spaces after the commas.
      header = row.map((h) => h.trim());
      continue;
    }
    const obj: Record<string, string> = {};
    for (const [i, key] of header.entries()) obj[key] = (row[i] ?? "").trim();
    yield obj;
  }
}

export interface IngestOptions {
  onNote?: (note: string) => void;
  onProgress?: (rows: number) => void;
  /** Stop after this many rows. For tests and for a quick look at a new source. */
  limit?: number;
  /**
   * Index a file already on disk instead of downloading one.
   *
   * Two real uses, not a test hook that leaked: somebody who already has the
   * export (they are large, and mirrored), and the unit suite, which is forbidden
   * from touching the network at all.
   */
  fromFile?: string;
}

/**
 * Stream a large file to disk.
 *
 * Deliberately `fetch` rather than the engine's `httpGet`. `httpGet` returns the
 * whole body as a Buffer and may cache it — right for an API response, wrong for
 * 470 MB: it would spike memory by half a gigabyte and put the same half gigabyte
 * a second time into a cache meant for pages. The politeness that matters here is
 * the identifying User-Agent, and that is passed explicitly.
 */
async function downloadTo(url: string, path: string): Promise<{ ok: boolean; status: number; lastModified?: string }> {
  const res = await fetch(url, { headers: { "user-agent": politeUa() } });
  if (!res.ok || !res.body) return { ok: false, status: res.status };
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
  return { ok: true, status: res.status, lastModified: res.headers.get("last-modified") ?? undefined };
}

/**
 * Fetch a bulk export and index it into the cache.
 *
 * Replaces any previous snapshot for the connector wholesale rather than merging.
 * A monthly product is a new census, not a patch: keeping last month's rows for
 * companies that have since been struck off would make the cache say something
 * neither snapshot ever said.
 */
export async function ingestSnapshot(connectorId: string, source: SnapshotSource, opts: IngestOptions = {}): Promise<SnapshotMeta> {
  const note = opts.onNote ?? (() => {});
  const target = dir(connectorId);
  const download = join(target, `download.${source.format.replace(/\./g, "-")}`);

  mkdirSync(target, { recursive: true });

  // ---- Fetch ----------------------------------------------------------------
  let used: { url: string; lastModified?: string };
  let source_file: string;
  if (opts.fromFile) {
    if (!existsSync(opts.fromFile)) throw new Error(`ingest: ${opts.fromFile} does not exist`);
    used = { url: `file://${opts.fromFile}` };
    source_file = opts.fromFile;
  } else {
    // Both numbers, because the download is the smaller surprise: an index of the
    // whole German register is several gigabytes, and finding that out afterwards
    // is not the same as being told.
    note(
      `ingest: ${connectorId} — about to download roughly ${Math.round(source.approxBytes / 1e6)} MB and index it into about ${Math.round((source.approxDiskBytes ?? source.approxBytes * 4) / 1e9)} GB under ${cacheDir()}. This runs once; every query afterwards is local.`,
    );
    const failures: string[] = [];
    let got: { url: string; lastModified?: string } | undefined;
    // The candidate list is tried in order, and a 404 on the first is EXPECTED for
    // a monthly product in the first week of a month rather than a failure.
    for (const url of source.urls(new Date())) {
      const res = await downloadTo(url, download);
      if (!res.ok) {
        failures.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      got = { url, lastModified: res.lastModified };
      break;
    }
    if (!got) throw new Error(`ingest: could not download a snapshot for ${connectorId}. Tried: ${failures.join("; ")}`);
    used = got;
    source_file = download;
    note(`ingest: ${used.url} (${(statSync(download).size / 1e6).toFixed(0)} MB${used.lastModified ? `, last modified ${used.lastModified}` : ""})`);
  }

  // ---- Index ----------------------------------------------------------------
  //
  // One open handle per shard per index. 512 handles is well inside every default
  // ulimit, and it is what makes this a single pass over a multi-gigabyte
  // decompressed stream instead of one pass per shard.
  for (const sub of ["loc", "id"]) rmSync(join(target, sub), { recursive: true, force: true });
  for (const sub of ["loc", "id"]) mkdirSync(join(target, sub), { recursive: true });

  const handles = new Map<string, ReturnType<typeof createWriteStream>>();
  const streamFor = (index: "loc" | "id", bucket: string) => {
    const key = `${index}/${bucket}`;
    let s = handles.get(key);
    if (!s) {
      s = createWriteStream(join(target, index, `${bucket}.jsonl`), { flags: "a" });
      handles.set(key, s);
    }
    return s;
  };
  /** Backpressure: a write that returns false means the buffer is full. */
  const writeLine = async (index: "loc" | "id", bucket: string, line: string) => {
    const s = streamFor(index, bucket);
    if (!s.write(line)) await new Promise<void>((resolve) => s.once("drain", () => resolve()));
  };

  // Every record from a snapshot is dated, and the date is filled in HERE rather
  // than by each connector's parser. A parser sees one row and cannot know which
  // month's file it came out of; the ingest does. A per-record date the source
  // itself carries — OffeneRegister stamps `retrieved_at` on each entry — is left
  // alone, because it is more precise than the file's.
  const fallbackAsOf = source.vintage ?? (used.lastModified ? new Date(used.lastModified).toISOString().slice(0, 10) : undefined);

  let rows = 0;
  let skipped = 0;
  try {
    for await (const raw of rowsOf(source, source_file)) {
      if (opts.limit && rows >= opts.limit) break;
      const mapped = raw === undefined ? undefined : source.parse(raw);
      if (!mapped) {
        skipped++;
        continue;
      }
      if (!mapped.record.asOf && fallbackAsOf) mapped.record.asOf = fallbackAsOf;
      rows++;
      const localityKey = mapped.locality ? snapshotKey(mapped.locality) : "";
      // The locality key is stored WITH the record, not merely used to choose its
      // shard. A shard is a hash bucket, so it holds every town that collided:
      // without this field a lookup in Berlin returned a bakery in Ulm, which is
      // a plausible-looking company in a report about somewhere else. ~20 bytes a
      // row against a wrong answer nobody would catch.
      const record = `${JSON.stringify({ l: localityKey, r: mapped.record })}\n`;
      if (localityKey) await writeLine("loc", bucketOf(localityKey), record);

      for (const id of new Set(mapped.ids.map(snapshotKey).filter(Boolean))) {
        // A pointer when the record is reachable through a locality, the record
        // itself when it is not — a row with no town would otherwise be findable
        // by nothing at all.
        const line = localityKey ? `${JSON.stringify({ k: id, l: localityKey })}\n` : record;
        await writeLine("id", bucketOf(id), line);
      }
      if (rows % 250_000 === 0) opts.onProgress?.(rows);
    }
  } finally {
    await Promise.all(
      [...handles.values()].map(
        (s) =>
          new Promise<void>((resolve) => {
            s.end(() => resolve());
          }),
      ),
    );
  }

  if (rows === 0) {
    throw new Error(`ingest: ${connectorId} mapped 0 of ${skipped} rows. The export's shape has moved — do not trust the cache, fix the parser.`);
  }
  // A mapper rejecting most of what it was given is drift, not data. Said out
  // loud rather than left in a ratio nobody computes.
  if (skipped > rows) note(`ingest: ${connectorId} skipped ${skipped} rows and kept ${rows}. That ratio is worth a look — the export's shape may have moved.`);

  // Only ever delete what we downloaded. A file the caller pointed us at is
  // theirs, and removing it would be an unpleasant surprise.
  if (!opts.fromFile) rmSync(download, { force: true });

  const meta: SnapshotMeta = {
    connectorId,
    toolVersion: VERSION,
    sourceUrl: used.url,
    lastModified: used.lastModified,
    vintage: source.vintage,
    licence: source.licence,
    ingestedAt: new Date().toISOString(),
    rows,
    skipped,
    bytesOnDisk: directorySize(target),
  };
  writeFileSync(join(target, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  note(`ingest: ${connectorId} — ${rows} records indexed, ${(meta.bytesOnDisk / 1e6).toFixed(0)} MB on disk at ${target}`);
  return meta;
}

/** Read one locality shard, keeping records whose locality is EXACTLY the one asked for. */
async function scanLocality(connectorId: string, key: string, keep: (r: RegistryRecord) => boolean, limit: number): Promise<RegistryRecord[]> {
  const path = join(dir(connectorId), "loc", `${bucketOf(key)}.jsonl`);
  if (!existsSync(path)) return [];
  const out: RegistryRecord[] = [];
  for await (const line of linesOf(createReadStream(path, { encoding: "utf8" }))) {
    if (!line) continue;
    let parsed: { l?: string; r?: RegistryRecord };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // The exact-key check is NOT redundant with having chosen the shard. 256
    // buckets over thousands of towns collide constantly, and the first version
    // trusted the bucket: a lookup in Berlin came back holding a bakery in Ulm —
    // a real company, correctly transcribed, in a report about another city.
    if (parsed.l !== key || !parsed.r) continue;
    if (!keep(parsed.r)) continue;
    out.push(parsed.r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Every record filed under a locality, filtered by the caller. */
export function snapshotByLocality(connectorId: string, locality: string, keep: (r: RegistryRecord) => boolean, limit = 5000): Promise<RegistryRecord[]> {
  const key = snapshotKey(locality);
  if (!key) return Promise.resolve([]);
  return scanLocality(connectorId, key, keep, limit);
}

/**
 * Every record filed under an identifier.
 *
 * Two scans. The identifier shard holds pointers to a locality plus, for the rare
 * record that has no town, the record itself; then each named locality shard is
 * read and filtered on the exact key. The shard is a HASH bucket, so it holds
 * every identifier that collided — matching the exact key here rather than
 * trusting the bucket is what keeps a lookup from returning a stranger.
 */
export async function snapshotById(connectorId: string, id: string, limit = 20): Promise<RegistryRecord[]> {
  const key = snapshotKey(id);
  if (!key) return [];

  const path = join(dir(connectorId), "id", `${bucketOf(key)}.jsonl`);
  if (!existsSync(path)) return [];

  const localities = new Set<string>();
  const inline: RegistryRecord[] = [];
  for await (const line of linesOf(createReadStream(path, { encoding: "utf8" }))) {
    if (!line) continue;
    let parsed: { k?: string; l?: string } & Partial<RegistryRecord>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed.k === "string" && typeof parsed.l === "string") {
      if (parsed.k === key) localities.add(parsed.l);
      continue;
    }
    // A record stored inline: it had no locality to be reached through.
    const rec = parsed as RegistryRecord;
    if (rec.id && snapshotIdsOf(rec).includes(key)) inline.push(rec);
  }

  const out = [...inline];
  for (const locality of localities) {
    if (out.length >= limit) break;
    const found = await scanLocality(connectorId, locality, (r) => snapshotIdsOf(r).includes(key), limit - out.length);
    out.push(...found);
  }
  return out.slice(0, limit);
}

/**
 * The keys a stored record is findable by.
 *
 * Derived from the record rather than stored beside it, so the shard stays one
 * JSON object per line and there is exactly one definition of what an identifier
 * for a record is.
 */
export function snapshotIdsOf(rec: RegistryRecord): string[] {
  // `national` is per-country by design, so the identifier names differ. These
  // are the ones a legal notice actually prints: the register's own number, and
  // Germany's court-qualified form ("Hamburg HRB 150148"), which is the only
  // shape that distinguishes an HRB number from the same number at another court.
  const raw = [rec.id, rec.national?.companyNumber, rec.national?.registerNumber];
  return [
    ...new Set(
      raw
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .map(snapshotKey)
        .filter(Boolean),
    ),
  ];
}

/**
 * Snapshots indexed by an older version of this tool.
 *
 * Reported rather than auto-rebuilt: re-ingesting is a 500 MB download and
 * several minutes, and deciding to spend that is the operator's call. Saying
 * nothing would be the worse half of the choice.
 */
export function staleSnapshots(): SnapshotMeta[] {
  return listSnapshots().filter((m) => m.toolVersion !== VERSION);
}

/** Drop a snapshot, for `ingest --forget`. */
export function forgetSnapshot(connectorId: string): boolean {
  const target = dir(connectorId);
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}
