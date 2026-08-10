// Small pure helpers. Nothing here touches the network or the disk.
//
// Names are deliberately distinct from the engine's (`slugify`, `sleep`,
// `mapLimit`, `canonicalizeUrl`… all come from ./engine.js): a local helper that
// shadows an engine export is exactly the drift `verify:engine` refuses.

/** Metres between two WGS84 points. */
export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Strip diacritics so "Boulangerie Rêve" and "BOULANGERIE REVE" compare equal. */
export function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Legal forms and their punctuation carry no identifying signal — every third
// French company is a SAS — but they dominate a token overlap if left in.
const LEGAL_FORMS =
  /\b(?:sarl|sas|sasu|eurl|sa|sci|scp|scm|selarl|snc|gie|eirl|earl|scop|scic|asso(?:ciation)?|societe|ste|ets|etablissements?|entreprise|cie|compagnie|groupe|holding|france|international|gmbh|ltd|llc|inc|bv|nv|spa|srl|plc|ag)\b/g;

/**
 * Canonical form for name comparison: accent-folded, lowercased, legal forms
 * and punctuation removed, whitespace collapsed.
 *
 * Returns "" when a name is nothing but legal boilerplate. Callers must treat
 * an empty result as "no name signal", never as a match — two companies called
 * only "SARL" are not the same company.
 */
export function normalizeName(raw: string): string {
  return foldAccents(raw)
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_FORMS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSet(s: string): Set<string> {
  return new Set(s.split(" ").filter((t) => t.length > 1));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/**
 * Generic trade nouns that identify a KIND of business, not a business.
 *
 * These exist because containment scoring is otherwise dangerous: `{creche}` is
 * a subset of `{creche, burgeat}`, and treating that as identity would merge
 * every nursery in a town with every other one. A word on this list can never
 * carry a containment match on its own.
 */
const GENERIC_TRADE_WORDS = new Set([
  "creche",
  "ecole",
  "college",
  "lycee",
  "boulangerie",
  "patisserie",
  "boucherie",
  "pharmacie",
  "restaurant",
  "brasserie",
  "cafe",
  "bar",
  "tabac",
  "presse",
  "garage",
  "hotel",
  "salon",
  "coiffure",
  "agence",
  "cabinet",
  "centre",
  "maison",
  "clinique",
  "institut",
  "bureau",
  "magasin",
  "boutique",
  "atelier",
  "banque",
  "immobilier",
  "opticien",
  "pressing",
  "fleuriste",
  "librairie",
  "supermarche",
  "epicerie",
  "traiteur",
  "primeur",
  "poissonnerie",
  "fromagerie",
  "caviste",
  "auto",
  "ecole",
  "taxi",
  "clinic",
  "shop",
  "store",
  "market",
  "school",
  "office",
]);

/**
 * True when one name is the other plus qualifiers: "Marionnaud" inside
 * "Marionnaud Lafayette", "Crèche Burgeat" inside "Crèche Jean Burgeat".
 *
 * This is the single most common shape of a real match between a shopfront and
 * a register entry, and neither Jaccard measure sees it: both punish the extra
 * tokens the longer name carries, so a certain match scores 0.5 and lands in
 * the undecided pile.
 *
 * Guarded twice, because unguarded containment is how a matcher starts merging
 * unrelated neighbours: a single shared token only counts if it is long enough
 * to be a name and is not a generic trade noun.
 */
export function isNameContained(a: string, b: string): boolean {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!large.has(t)) return false;
  if (small.size >= 2) return true;
  const only = [...small][0]!;
  return only.length >= 6 && !GENERIC_TRADE_WORDS.has(only);
}

/**
 * The register packs trade names into the legal one:
 * `"KID'HOME SERVICES (KLEEN'HOME SERVICES)"`, `"CREDIT LYONNAIS (LCL)"`.
 *
 * Compared whole, the parenthesised alternates are noise that drags every
 * measure down. Split out, each is a name the business actually goes by — and
 * usually the one on the shopfront OSM recorded.
 */
export function nameVariants(raw: string): string[] {
  const variants = [raw];
  const outside = raw.replace(/\([^)]*\)/g, " ").trim();
  if (outside && outside !== raw) variants.push(outside);
  for (const m of raw.matchAll(/\(([^)]+)\)/g)) {
    for (const part of m[1]!.split(/[,;]/)) {
      const v = part.trim();
      if (v) variants.push(v);
    }
  }
  return [...new Set(variants.filter(Boolean))];
}

/**
 * 0-1 name similarity: the best of containment, token overlap and trigram
 * overlap, across every parenthesised variant of both names.
 *
 * Three measures rather than one because they fail on different inputs. Token
 * overlap misses reordering and qualifiers; trigrams handle spelling drift but
 * score short names generously; containment catches the shopfront-versus-
 * register shape that the other two both punish. Taking the max lets each cover
 * the others' blind spot, and the matcher's thresholds are calibrated against
 * that combined measure.
 */
export function nameSimilarity(a: string, b: string): number {
  let best = 0;
  for (const va of nameVariants(a)) {
    for (const vb of nameVariants(b)) {
      const na = normalizeName(va);
      const nb = normalizeName(vb);
      if (!na || !nb) continue;
      if (na === nb) return 1;
      // Just below an exact match: the qualifier could still be a different
      // branch of the same brand, which is a distinction the address decides.
      const contained = isNameContained(na, nb) ? 0.88 : 0;
      const tok = jaccard(tokenSet(na), tokenSet(nb));
      const tri = jaccard(trigrams(na), trigrams(nb));
      best = Math.max(best, contained, tok, tri);
      if (best >= 1) return 1;
    }
  }
  return best;
}

/** The variant of `candidates` that best matches `probe`, with its score. */
export function bestNameMatch(probe: string, candidates: readonly string[]): { name?: string; score: number } {
  let best = { name: undefined as string | undefined, score: 0 };
  for (const c of candidates) {
    const score = nameSimilarity(probe, c);
    if (score > best.score) best = { name: c, score };
  }
  return best;
}

/** Split a bbox into four equal quadrants. Used to get under an upstream cap. */
export function bboxQuadrants(bbox: [number, number, number, number]): [number, number, number, number][] {
  const [s, n, w, e] = bbox;
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return [
    [s, midLat, w, midLon],
    [s, midLat, midLon, e],
    [midLat, n, w, midLon],
    [midLat, n, midLon, e],
  ];
}

/** Rough metres-per-degree box around a point, for radius searches. */
export function bboxAround(lat: number, lon: number, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
}

/** RFC 4180 field: quote when the value contains a delimiter, quote or newline. */
export function csvField(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvField).join(",");
}

/** First non-empty, non-whitespace string in the list. */
export function firstText(...values: (string | undefined | null)[]): string | undefined {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** Clamp to a range, tolerating NaN by falling back to the minimum. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Parse a human distance into metres: `800`, `800m`, `2km`, `1.5 km`.
 *
 * A bare number is metres. Getting this backwards would turn a 2 km sweep into
 * a 2 m one and return an empty run that looks like an empty territory.
 */
export function parseDistanceM(raw: string): number | undefined {
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m|km)?\s*$/i.exec(raw);
  if (!m) return undefined;
  const value = Number.parseFloat(m[1]!.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return (m[2] ?? "m").toLowerCase() === "km" ? Math.round(value * 1000) : Math.round(value);
}

/** `48.81,2.22,48.90,2.47` (south,west,north,east) -> [s,n,w,e]. */
export function parseBbox(raw: string): [number, number, number, number] | undefined {
  const parts = raw.split(",").map((p) => Number.parseFloat(p.trim()));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return undefined;
  const [s, w, n, e] = parts as [number, number, number, number];
  if (s >= n || w >= e) return undefined;
  return [s, n, w, e];
}
