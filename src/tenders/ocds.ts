// The Open Contracting Data Standard, read once for every publisher that speaks it.
//
// Find a Tender, Contracts Finder, AusTender and the German Bekanntmachungs-
// service all publish OCDS 1.1 releases, and each fills a different subset:
// measured on 2026-11-02,
//
// - Find a Tender: tender stage, lots with award criteria and durations, CPV
//   in `tender.classification`, deadlines in `tender.tenderPeriod.endDate`.
// - Contracts Finder: awards with suppliers, values and contract periods; CPV
//   in `tender.classification` too.
// - AusTender: CONTRACT notices only — `awards` + `contracts`, classified in
//   UNSPSC, suppliers identified by ABN under `additionalIdentifiers`.
// - oeffentlichevergabe.de: one release per notice, buyer identified by its
//   register number ("HRB 4923"), country as alpha-3 ("DEU").
//
// One reader, then, that takes what is there and invents nothing that is not.
import type { NoticeKind, Tender, TenderAward, TenderCoverage, TenderLot } from "./types.js";
import { cpvDigits, dayOf, durationMonths, iso2, money, natureOf, statusFromDeadline, plainText } from "./util.js";

export interface OcdsContext {
  connectorId: string;
  country: string;
  coverage: TenderCoverage;
  /** Build the human page for a release, when the publisher has one. */
  sourceUrl?: (release: any) => string | undefined;
  now?: Date;
}

export function kindOfTags(tags: unknown, release: any): NoticeKind {
  const t = (Array.isArray(tags) ? tags : [tags]).map((x) => String(x ?? "").toLowerCase());
  if (t.some((x) => x.includes("cancel"))) return "cancellation";
  if (t.some((x) => x.startsWith("award") || x.startsWith("contract"))) return "award";
  if (t.some((x) => x.includes("planning"))) return "prior";
  if (t.some((x) => x.includes("amendment") || x.includes("update"))) return "modification";
  if (Array.isArray(release?.awards) && release.awards.length && !t.includes("tender")) return "award";
  return "call";
}

function partyById(release: any, id: string | undefined): any {
  if (!id) return undefined;
  return (release?.parties ?? []).find((p: any) => p?.id === id);
}

function identifierOf(party: any): string | undefined {
  const main = party?.identifier?.id;
  if (main && /\d/.test(String(main))) return String(main);
  const extra = (party?.additionalIdentifiers ?? []).find((x: any) => x?.id);
  return extra ? `${extra.scheme ? `${extra.scheme} ` : ""}${extra.id}` : undefined;
}

function cpvOf(release: any): string[] {
  const t = release?.tender ?? {};
  const out = new Set<string>();
  const take = (c: any) => {
    if (!c) return;
    if (String(c.scheme ?? "").toUpperCase() !== "CPV") return;
    const d = cpvDigits(c.id);
    if (d) out.add(d);
  };
  take(t.classification);
  for (const c of t.additionalClassifications ?? []) take(c);
  for (const item of t.items ?? []) {
    take(item?.classification);
    for (const c of item?.additionalClassifications ?? []) take(c);
  }
  return [...out];
}

function otherClassifications(release: any): string[] {
  const out = new Set<string>();
  const add = (c: any) => {
    if (c?.id && c?.scheme && String(c.scheme).toUpperCase() !== "CPV") out.add(`${c.scheme}:${c.id}`);
  };
  const t = release?.tender ?? {};
  add(t.classification);
  for (const item of [...(t.items ?? []), ...(release?.contracts ?? []).flatMap((c: any) => c?.items ?? [])]) add(item?.classification);
  return [...out];
}

function monthsOfPeriod(p: any): number | undefined {
  if (!p) return undefined;
  if (typeof p.durationInDays === "number") return durationMonths(p.durationInDays, "DAY");
  const start = dayOf(p.startDate);
  const end = dayOf(p.endDate);
  if (start && end) {
    const ms = Date.parse(end) - Date.parse(start);
    if (ms > 0) return Math.max(1, Math.round(ms / (30.44 * 86_400_000)));
  }
  return undefined;
}

export function releaseToTender(release: any, ctx: OcdsContext): Tender | undefined {
  if (!release?.id && !release?.ocid) return undefined;
  const t = release.tender ?? {};
  const kind = kindOfTags(release.tag, release);
  const buyerParty =
    partyById(release, release.buyer?.id) ??
    (release.parties ?? []).find((p: any) => (p?.roles ?? []).some((r: string) => r === "buyer" || r === "procuringEntity"));
  const buyerName = release.buyer?.name ?? buyerParty?.name ?? "";
  const country = iso2(buyerParty?.address?.countryName) ?? ctx.country;
  const deadline: string | undefined = t.tenderPeriod?.endDate ?? undefined;

  const lots: TenderLot[] = (t.lots ?? []).map((l: any) => ({
    id: l?.id ? String(l.id) : undefined,
    title: l?.title ?? (typeof l?.description === "string" ? l.description.split("\n")[0]?.slice(0, 200) : undefined),
    value: money(l?.value?.amount, l?.value?.currency, true),
  }));
  const criteria = (t.lots ?? [])
    .flatMap((l: any) => l?.awardCriteria?.criteria ?? [])
    .concat(t.awardCriteria?.criteria ?? [])
    .map((c: any) => ({
      name: String(c?.name ?? c?.type ?? "criterion"),
      weight: typeof c?.description === "string" && c.description.length < 20 ? c.description : undefined,
    }));

  const contractPeriodMonths = monthsOfPeriod(t.contractPeriod) ?? monthsOfPeriod((t.lots ?? [])[0]?.contractPeriod);
  const awards: TenderAward[] = [];
  for (const a of release.awards ?? []) {
    const contract = (release.contracts ?? []).find((c: any) => c?.awardID === a?.id);
    const value = money(a?.value?.amount ?? contract?.value?.amount, a?.value?.currency ?? contract?.value?.currency, false);
    const period = a?.contractPeriod ?? contract?.period;
    for (const s of a?.suppliers ?? []) {
      const party = partyById(release, s?.id);
      awards.push({
        supplier: {
          name: s?.name ?? party?.name ?? "",
          legalId: identifierOf(party),
          country: iso2(party?.address?.countryName),
          city: party?.address?.locality,
        },
        value,
        date: dayOf(contract?.dateSigned ?? a?.date),
        durationMonths: monthsOfPeriod(period) ?? contractPeriodMonths,
        endDate: dayOf(period?.endDate),
        size: party?.details?.scale,
      });
    }
  }

  const documents: string[] = [...(t.documents ?? []), ...(release.awards ?? []).flatMap((a: any) => a?.documents ?? [])]
    .map((d: any) => d?.url)
    .filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  const submission = typeof t.submissionMethodDetails === "string" && /^https?:\/\//.test(t.submissionMethodDetails) ? t.submissionMethodDetails : undefined;
  const regions = new Set<string>();
  for (const item of t.items ?? []) {
    for (const a of item?.deliveryAddresses ?? []) if (a?.region) regions.add(String(a.region));
    if (item?.deliveryAddress?.region) regions.add(String(item.deliveryAddress.region));
  }
  for (const a of t.deliveryAddresses ?? []) if (a?.region) regions.add(String(a.region));
  const contract0 = (release.contracts ?? [])[0];
  const value =
    kind === "award"
      ? (awards[0]?.value ?? money(contract0?.value?.amount, contract0?.value?.currency, false))
      : money(t.value?.amount, t.value?.currency, true);
  const title = t.title ?? contract0?.description ?? contract0?.title ?? release.description ?? String(release.id);
  const noticeId = String(release.id ?? release.ocid);
  const cpv = cpvOf(release);
  const other = otherClassifications(release);

  return {
    id: `${ctx.connectorId}:${noticeId}`,
    connectorId: ctx.connectorId,
    noticeId,
    country,
    kind,
    status: t.status === "cancelled" ? "cancelled" : statusFromDeadline(kind, deadline, ctx.now),
    title: String(title).slice(0, 500),
    description: plainText(t.description ?? contract0?.description) ?? undefined,
    language: typeof release.language === "string" ? release.language.toLowerCase() : undefined,
    buyer: { name: buyerName, legalId: identifierOf(buyerParty), country, city: buyerParty?.address?.locality },
    cpv,
    nature: natureOf(t.mainProcurementCategory),
    procedure: t.procurementMethodDetails ?? t.procurementMethod ?? undefined,
    value,
    lots: lots.length > 1 ? lots : [],
    publishedAt: dayOf(release.date),
    deadline,
    documentsUrl: documents[0] ?? submission,
    documentsAccess: "unknown",
    submissionUrl: submission,
    places: [...regions],
    criteria,
    awards,
    sourceUrl: ctx.sourceUrl?.(release),
    coverage: ctx.coverage,
    aliases: [...new Set([noticeId, ...(release.ocid ? [String(release.ocid)] : []), ...(t.id ? [String(t.id)] : [])])],
    national: {
      ocid: release.ocid,
      tags: release.tag,
      ...(other.length ? { classifications: other } : {}),
      ...(cpv.length ? {} : { noCpvScheme: other.length > 0 }),
    },
  };
}

export function packageToTenders(pkg: any, ctx: OcdsContext): Tender[] {
  const releases: any[] = Array.isArray(pkg?.releases) ? pkg.releases : Array.isArray(pkg) ? pkg : [];
  return releases.map((r) => releaseToTender(r, ctx)).filter((t): t is Tender => Boolean(t));
}
