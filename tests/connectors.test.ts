// The connectors' mappers, against the shapes their APIs actually returned.
//
// Every fixture in this file is a trimmed copy of a real response, captured
// while building the connector — WITH ONE EXCEPTION, named here rather than left
// for a reader to discover. `gb-companies-house`'s cases are hand-written
// minimal objects: it is the only connector behind a credential, nobody has ever
// held the key, and its canary has therefore reported INCONCLUSIVE on every
// scheduled run since it was written. Calling those stubs captured responses
// would make this comment the same kind of claim the rest of the file exists to
// prevent. The connector declares the gap in `unverified`, and its keyless
// snapshot route is what actually gets exercised.
//
// The cases are deliberately weighted towards the four traps that were found by
// RUNNING the connectors rather than by reading their documentation — each of
// them produced a confidently wrong record first:
//
//   * PRH's `status` is not a liveness flag. Nokia came back "ceased".
//   * VIES redacts the trader name for some member states. A record with no
//     name would have been attached as an identity.
//   * A French ESTABLISHMENT is closed with "F", not "C". Closed offices came
//     back "unknown", which reads as "we did not look".
//   * GLEIF's fuzzy search answers about companies that merely resemble the
//     query, so a register number has to be re-checked exactly.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { euVies } from "../src/registry/eu-vies.js";
import { parseViesAddress, viesVerdict } from "../src/registry/eu-vies.js";
import { toRecord as aresRecord } from "../src/registry/cz-ares.js";
import { toRecord as brregRecord } from "../src/registry/no-brreg.js";
import { toRecord as chRecord } from "../src/registry/gb-companies-house.js";
import { toRecord as edgarRecord } from "../src/registry/us-edgar.js";
import { toRecord as gleifRecord } from "../src/registry/gleif.js";
import { toRecord as krsRecord } from "../src/registry/pl-krs.js";
import { toRecord as prhRecord } from "../src/registry/fi-prh.js";
import { expandRecord, frSirene } from "../src/registry/fr-sirene.js";
import { gbCompaniesHouse } from "../src/registry/gb-companies-house.js";
import { CONNECTORS, connectorsFor } from "../src/registry/index.js";
import { licencesFor } from "../src/run.js";

describe("fi-prh", () => {
  // Trimmed from the live answer for businessId 0112038-9 (Nokia Oyj).
  const nokia = {
    businessId: { value: "0112038-9", registrationDate: "1978-03-15" },
    status: "2",
    tradeRegisterStatus: "1",
    names: [
      { name: "Nokia Oyj", type: "1", registrationDate: "1997-09-01" },
      { name: "Oy Nokia Ab", type: "1", registrationDate: "1966-06-10", endDate: "1997-08-31" },
      { name: "Nokia Networks", type: "3", registrationDate: "2001-10-01" },
    ],
    mainBusinessLine: { type: "70100" },
    addresses: [
      {
        type: 1,
        street: "Karakaari",
        buildingNumber: "7",
        postCode: "02610",
        postOffices: [
          { city: "ESBO", languageCode: "2", municipalityCode: "049" },
          { city: "ESPOO", languageCode: "1", municipalityCode: "049" },
        ],
      },
      { type: 2, street: "", postCode: "00045", postOfficeBox: "226", postOffices: [{ city: "NOKIA GROUP", languageCode: "1" }] },
    ],
  };

  it("does NOT read status as liveness — a live company reports status 2 too", () => {
    // Measured over 73 records: live and dissolved companies both carry
    // status "2". Reading it as liveness reported Nokia as ceased.
    expect(prhRecord(nokia)!.status).toBe("active");
    expect(prhRecord({ ...nokia, endDate: "2005-12-19" })!.status).toBe("ceased");
    expect(prhRecord({ ...nokia, tradeRegisterStatus: "4" })!.status).toBe("unknown");
  });

  it("takes the street address, whose type is a NUMBER, over the PO box", () => {
    const rec = prhRecord(nokia)!;
    expect(rec.address.libelleVoie).toBe("Karakaari");
    expect(rec.address.codePostal).toBe("02610");
  });

  it("prefers the Finnish city name over the Swedish exonym", () => {
    // "ESBO" is Swedish for Espoo. An OSM `addr:city` will say ESPOO, and a
    // matcher handed the exonym scores zero against it.
    expect(prhRecord(nokia)!.address.commune).toBe("ESPOO");
  });

  it("keeps expired names for matching but never as the company's identity", () => {
    const rec = prhRecord(nokia)!;
    expect(rec.legalName).toBe("Nokia Oyj");
    expect(rec.names).toContain("Oy Nokia Ab");
    expect(rec.names.indexOf("Oy Nokia Ab")).toBeGreaterThan(rec.names.indexOf("Nokia Oyj"));
    expect(rec.tradingNames).toEqual(["Nokia Networks"]);
  });

  it("resolves the Finnish activity code to a NACE section", () => {
    expect(prhRecord(nokia)!.section).toBe("M");
  });
});

describe("eu-vies", () => {
  it("parses a member state's address blob without inventing the parts it cannot read", () => {
    const parsed = parseViesAddress("VIA GAETANO NEGRI 1 \n20123 MILANO MI\n", "IT");
    expect(parsed.libelleVoie).toBe("VIA GAETANO NEGRI 1");
    expect(parsed.codePostal).toBe("20123");
    expect(parsed.commune).toBe("MILANO MI");
    expect(parsed.raw).toContain("GAETANO NEGRI");
  });

  it("keeps the whole answer in raw when the shape is not recognised", () => {
    const parsed = parseViesAddress("SOMEWHERE ELSE", "LU");
    expect(parsed.raw).toBe("SOMEWHERE ELSE");
    expect(parsed.codePostal).toBeUndefined();
  });

  it("serves every member state including Greece, which files under EL", () => {
    expect(euVies.countries).toContain("gr");
    expect(euVies.countries.length).toBe(27);
  });

  it("distinguishes an invalid number from a member state that did not answer", () => {
    // MEASURED on a live run: VIES answers `isValid: false` alongside
    // `userError: "MS_UNAVAILABLE"` when the member state's own system is down.
    // Reading that as "invalid" reports somebody else's outage as a fact about
    // a company — wrong in a way that looks exactly like right.
    expect(viesVerdict({ isValid: false, userError: "INVALID" })).toBe("invalid");
    expect(viesVerdict({ isValid: false, userError: "MS_UNAVAILABLE" })).toBe("inconclusive");
    expect(viesVerdict({ isValid: false, userError: "TIMEOUT" })).toBe("inconclusive");
    expect(viesVerdict({ isValid: true, userError: "VALID" })).toBe("valid");
  });
});

describe("fr-sirene", () => {
  it("declares legal-form sweep filtering and the filed public-body rule", () => {
    expect(frSirene.sweepFiltersLegalForm).toBe(true);
    expect(frSirene.legalFormIsPublic?.("7210")).toBe(true);
    expect(frSirene.legalFormIsPublic?.("4710")).toBe(true);
    expect(frSirene.legalFormIsPublic?.("5710")).toBe(false);
  });

  it("declares the French OSM establishment and legal-unit references", () => {
    expect(frSirene.osmRefKeys?.map(({ tag, level, kind }) => ({ tag, level, kind }))).toEqual([
      { tag: "ref:FR:SIRET", level: "establishment", kind: "siret" },
      { tag: "ref:FR:SIREN", level: "legal-unit", kind: "siren" },
    ]);
    expect(frSirene.osmRefKeys?.find((key) => key.tag === "ref:FR:SIRET")?.normalise("3024746480117")).toBeNull();
  });

  it("reads an establishment closed with F as ceased, not as unknown", () => {
    // TWO VOCABULARIES: a legal unit is A/C, an establishment is A/F. Mapping
    // only A and C reported every closed office as "unknown", which downstream
    // reads as "we did not look" rather than as "it is shut".
    const [rec] = expandRecord({
      siren: "552100554",
      nom_complet: "PEUGEOT SA",
      siege: { siret: "55210055400021", adresse: "7 RUE HENRI SAINTE CLAIRE DEVILLE 92500 RUEIL-MALMAISON", etat_administratif: "F" },
      etat_administratif: "C",
    });
    expect(rec!.status).toBe("ceased");
  });

  it("still reads an active establishment as active", () => {
    const [rec] = expandRecord({
      siren: "794598813",
      nom_complet: "DOCTOLIB",
      siege: { siret: "79459881300077", adresse: "54 QUAI CHARLES PASQUA 92300 LEVALLOIS-PERRET", etat_administratif: "A" },
      etat_administratif: "A",
    });
    expect(rec!.status).toBe("active");
  });
});

describe("gleif", () => {
  // Trimmed from the live answer for Zalando SE.
  const zalando = {
    attributes: {
      lei: "529900YRFFGH5AXU4S86",
      entity: {
        legalName: { name: "Zalando SE", language: "de" },
        otherNames: [],
        legalAddress: { addressLines: ["Valeska-Gert-Straße 5"], city: "Berlin", country: "DE", postalCode: "10243" },
        status: "ACTIVE",
        registeredAs: "HRB 158855",
        legalForm: { id: "SGST" },
      },
      registration: { status: "LAPSED" },
    },
  };

  it("carries the national register number, which is the only keyless route from a German HRB", () => {
    const rec = gleifRecord(zalando)!;
    expect(rec.national?.registeredAs).toBe("HRB 158855");
    expect(rec.address.commune).toBe("Berlin");
    expect(rec.countryCode).toBe("de");
  });

  it("reads the ENTITY's status, not the LEI registration's", () => {
    // A lapsed LEI means the entity stopped paying for it. Reporting that as a
    // closed company would kill live businesses off on a technicality.
    expect(gleifRecord(zalando)!.status).toBe("active");
  });
});

describe("cz-ares", () => {
  it("takes the first CZ-NACE code that resolves, not the first code", () => {
    // The array is ragged and contains placeholders: 5-digit, 3-digit and "00"
    // all appear in one record.
    const rec = aresRecord({
      ico: "00177041",
      obchodniJmeno: "Škoda Auto a.s.",
      czNace2008: ["00", "29100", "45200"],
      sidlo: { nazevObce: "Mladá Boleslav", psc: 29301, nazevUlice: "tř. Václava Klementa", cisloDomovni: 869, kodObce: 535419 },
      seznamRegistraci: { stavZdrojeVr: "AKTIVNI" },
    })!;
    expect(rec.activityCode).toBe("29100");
    expect(rec.section).toBe("C");
    expect(rec.address.codePostal).toBe("29301");
  });

  it("reads a struck-off subject as ceased", () => {
    const rec = aresRecord({ ico: "1", obchodniJmeno: "X", seznamRegistraci: { stavZdrojeVr: "ZANIKLY" } })!;
    expect(rec.status).toBe("ceased");
  });
});

describe("no-brreg", () => {
  it("carries the exact headcount and the company's own website", () => {
    const rec = brregRecord({
      organisasjonsnummer: "923609016",
      navn: "EQUINOR ASA",
      hjemmeside: "www.equinor.com",
      antallAnsatte: 21393,
      harRegistrertAntallAnsatte: true,
      naeringskode1: { kode: "06.100" },
      organisasjonsform: { kode: "ASA", beskrivelse: "Allmennaksjeselskap" },
      postadresse: { postnummer: "4035", poststed: "STAVANGER", adresse: ["Postboks 8500"], kommunenummer: "1103" },
      historiskeNavn: [{ navn: "STATOIL ASA" }],
    })!;
    expect(rec.employees).toBe(21393);
    expect(rec.national?.hjemmeside).toBe("www.equinor.com");
    expect(rec.section).toBe("B");
    // A shopfront often still carries the name the company traded under years
    // ago, and Brreg is one of the few registers that publishes the trail.
    expect(rec.names).toContain("STATOIL ASA");
  });

  it("does not invent a headcount when the register did not register one", () => {
    const rec = brregRecord({ organisasjonsnummer: "1", navn: "X", antallAnsatte: 0, harRegistrertAntallAnsatte: false })!;
    expect(rec.employees).toBeUndefined();
  });
});

describe("us-edgar", () => {
  it("labels its activity as US SIC, never as NACE", () => {
    // NACE "D" is electricity and gas; US SIC "D" is all of manufacturing. A
    // section that lost its scheme would compare two different economies.
    const rec = edgarRecord({
      cik: "0000320193",
      name: "Apple Inc.",
      sic: "3571",
      sicDescription: "Electronic Computers",
      addresses: { business: { street1: "ONE APPLE PARK WAY", city: "CUPERTINO", stateOrCountry: "CA", zipCode: "95014" } },
    })!;
    expect(rec.activityScheme).toBe("us-sic");
    expect(rec.section).toBe("D");
    expect(rec.address.commune).toBe("CUPERTINO");
  });

  it("takes the business address, not the mailing one", () => {
    const rec = edgarRecord({
      cik: "1",
      name: "X",
      addresses: { business: { city: "AUSTIN" }, mailing: { city: "WILMINGTON" } },
    })!;
    expect(rec.address.commune).toBe("AUSTIN");
  });
});

describe("pl-krs", () => {
  it("reads the name and address out of the nested odpis", () => {
    const rec = krsRecord({
      odpis: {
        naglowekA: { numerKRS: "0000041581", stanPozycji: 1 },
        dane: {
          dzial1: {
            danePodmiotu: { nazwa: "GMINNA SPÓŁDZIELNIA", formaPrawna: "SPÓŁDZIELNIA", identyfikatory: { nip: "5490003728", regon: "00035457700000" } },
            siedzibaIAdres: {
              adres: { ulica: "KOŚCIELNA", nrDomu: "3", kodPocztowy: "32-608", miejscowosc: "OSIEK" },
              adresStronyInternetowej: "HTTPS://GSOSIEK.PL",
            },
          },
        },
      },
    })!;
    expect(rec.legalName).toBe("GMINNA SPÓŁDZIELNIA");
    expect(rec.address.codePostal).toBe("32-608");
    expect(rec.national?.website).toBe("HTTPS://GSOSIEK.PL");
  });
});

describe("gb-companies-house", () => {
  it("reports itself unavailable without a key instead of failing the run", () => {
    const availability = gbCompaniesHouse.availability({ keys: {} });
    expect(availability.available).toBe(false);
    if (!availability.available) {
      // The message has to be actionable: it is printed verbatim into a run. And
      // it now leads with the KEYLESS route, because that is the one that keeps
      // the tool's promise — a key is an optional upgrade, not the way in.
      expect(availability.how).toContain("ingest --country gb");
      expect(availability.reason).toContain("no Companies House snapshot");
    }
  });

  it("becomes available once a key is supplied", () => {
    expect(gbCompaniesHouse.availability({ keys: { "gb-companies-house": "abc" } }).available).toBe(true);
  });

  it("treats every non-active company_status as not trading", () => {
    for (const status of ["dissolved", "liquidation", "administration"]) {
      expect(chRecord({ company_number: "01", company_name: "X", company_status: status })!.status).toBe("ceased");
    }
    expect(chRecord({ company_number: "01", company_name: "X", company_status: "active" })!.status).toBe("active");
  });

  it("resolves a UK SIC code to the same NACE section a French code would", () => {
    // "62012" and "62.01Z" are the same division in two national spellings.
    expect(chRecord({ company_number: "01", company_name: "X", sic_codes: ["62012"] })!.section).toBe("J");
  });

  it("refuses to translate a UK administrative SIC code into a NACE section", () => {
    // Found by sweeping a real town, not by reading the spec. `99999` is
    // "Dormant company" — not an activity — but division 99 DOES exist in NACE,
    // so mapping it through filed fourteen dormant shells in Hebden Bridge as
    // "activities of extraterritorial organisations", and `--section U` would
    // have returned them.
    const dormant = chRecord({ company_number: "01", company_name: "X", sic_codes: ["99999"] })!;
    expect(dormant.section).toBeUndefined();
    expect(dormant.activityCode).toBe("99999");
    expect(dormant.national?.administrativeSic).toBe("dormant company");

    const residents = chRecord({ company_number: "01", company_name: "X", sic_codes: ["98000"] })!;
    expect(residents.section).toBeUndefined();
    expect(residents.national?.administrativeSic).toBe("residents property management");

    // And a real activity code is untouched: the exception is two codes, not a
    // retreat from the NACE mapping that makes --section portable.
    expect(chRecord({ company_number: "01", company_name: "X", sic_codes: ["86230"] })!.section).toBe("Q");
  });

  it("reads the legal form under BOTH names Companies House gives it", () => {
    // The company profile resource calls it `type`; every search resource calls
    // it `company_type`. `lookup` goes through /advanced-search first, so reading
    // only `type` dropped the legal form on the primary path and kept it on the
    // fallback — the same record arriving by two routes, one of them poorer.
    expect(chRecord({ company_number: "01", company_name: "X", type: "ltd" })!.legalForm).toBe("ltd");
    expect(chRecord({ company_number: "01", company_name: "X", company_type: "plc" })!.legalForm).toBe("plc");
  });
});

describe("the connector table", () => {
  it("gives every connector a stable id, a licence and an activity namespace", () => {
    for (const c of CONNECTORS) {
      expect(c.id, `${c.label} has no id`).toMatch(/^[a-z]{2}-[a-z-]+$|^gleif$/);
      expect(c.licence.length, `${c.id} has no licence`).toBeGreaterThan(10);
      expect(c.activityPrefix.length, `${c.id} has no activity namespace`).toBeGreaterThan(0);
      expect(c.countries.length, `${c.id} serves no country`).toBeGreaterThan(0);
    }
  });

  it("never gives a record a sourceUrl that does not address that record", () => {
    // Measured on a Hamburg run: 72 of 92 register records (78%) carried
    // `sourceUrl: "https://offeneregister.de/"` — the homepage. The panel
    // offered "open on the register" and it landed on a download site with
    // nothing about the company. offeneregister.de has no per-company page at
    // all: it publishes bulk files and a SQL API that is now gone. VIES is the
    // same shape, a search form with no permalink for a VAT number.
    //
    // A link that cannot show the record is the same class of claim this tool
    // refuses everywhere else — a search-result rank is not evidence of
    // ownership, a shared doorway is not evidence of identity. So the rule:
    // a sourceUrl opens THIS record, or the connector emits none and the page
    // says where the record came from instead.
    //
    // Enforced structurally rather than per-connector, so a country added
    // tomorrow inherits it: a URL that addresses a record has to interpolate
    // that record's identifier, and a constant string cannot.
    const dir = join(import.meta.dirname, "..", "src", "registry");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "types.ts" && f !== "index.ts")) {
      const src = readFileSync(join(dir, file), "utf8");
      for (const m of src.matchAll(/sourceUrl:\s*([^,\n]+)/g)) {
        const value = m[1]!.trim();
        // A template that interpolates, a ternary of them, or a field carried
        // through from the register's own answer, are all per-record. A plain
        // quoted constant is a homepage by construction.
        if (/^["']/.test(value) && !value.includes("${")) offenders.push(`${file}: ${value}`);
      }
    }
    expect(offenders, "a constant sourceUrl cannot address a single record").toEqual([]);
  });

  it("names every sweepable register, and there are now three of them", () => {
    // This assertion used to read "exactly one, and it is France's", and its own
    // comment anticipated the day it would change: "If a second connector ever
    // gains `sweep`, the report's wording about coverage has to be revisited."
    // That day was the Companies House Free Company Data Product — a keyless
    // monthly export that enumerates the register by post town. The report's
    // wording WAS revisited: `render` derives its coverage sentence from the lane's
    // mode, and the UK lane's reason says in words that a post town is not a
    // bounding box. Anything else gaining `sweep` needs the same treatment.
    const sweepers = CONNECTORS.filter((c) => c.sweep);
    expect(sweepers.map((c) => c.id).sort()).toEqual(["ee-ariregister", "fr-sirene", "gb-companies-house"]);
    // And they do NOT sweep the same shape, which is why each one's `reason` has
    // to name its own: France a bounding box, the UK a post town, Estonia an
    // administrative unit finer than either.
  });

  it("carries EVERY answering connector's attribution, not just the first", () => {
    // `confirm` records every authority that answered, joined with commas
    // ("eu-vies,gleif"). Reading that as ONE id resolved nothing, so a confirm run
    // using more than one connector shipped with no register attribution at all —
    // and a German confirm always uses more than one, against a CC-BY source where
    // attribution is a licence CONDITION rather than a courtesy. The broken case
    // and the working case differed by a comma, which is why it survived.
    const both = licencesFor([{ lane: "registry", mode: "confirm", connectorId: "eu-vies,gleif", requested: 5, returned: 5, truncated: false }]);
    expect(both.some((l) => l.includes("VIES"))).toBe(true);
    expect(both.some((l) => l.includes("GLEIF"))).toBe(true);
    // A lane that returned nothing owes nothing: attributing a connector whose
    // data is not in the run would be a false claim about provenance.
    const empty = licencesFor([{ lane: "registry", connectorId: "eu-vies,gleif", requested: 5, returned: 0, truncated: false }]);
    expect(empty.some((l) => l.includes("VIES"))).toBe(false);
  });

  it("declares a bulk snapshot only where the register publishes one", () => {
    // The two registers with no queryable API and a file instead. `ingest` reads
    // this rather than a list of its own, so a new bulk source is a connector edit.
    expect(
      CONNECTORS.filter((c) => c.snapshot)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["de-offeneregister", "ee-ariregister", "gb-companies-house"]);
  });

  it("gives a country with no sweepable register its confirm connectors", () => {
    const germany = connectorsFor("de");
    expect(germany.sweep).toBeUndefined();
    // de-offeneregister is absent until its snapshot is ingested, and says so
    // rather than being dropped — the same treatment a missing key gets.
    expect(germany.confirm.map((c) => c.id)).toEqual(["eu-vies", "gleif"]);
    expect(germany.unavailable.map(({ connector }) => connector.id)).toContain("de-offeneregister");
  });

  it("puts national registers before the cross-border authorities", () => {
    // Order is behaviour: `confirm` takes the first answer, and a national
    // register knows strictly more about its own country than VIES or GLEIF.
    const france = connectorsFor("fr");
    expect(france.confirm[0]!.id).toBe("fr-sirene");
    expect(france.confirm.at(-1)!.id).toBe("gleif");
  });

  it("reports a key-gated connector as unavailable rather than dropping it silently", () => {
    const uk = connectorsFor("gb", { ctx: { keys: {} } });
    expect(uk.confirm.map((c) => c.id)).not.toContain("gb-companies-house");
    expect(uk.unavailable.map(({ connector }) => connector.id)).toContain("gb-companies-house");
  });

  it("still reaches a country nobody wrote a national connector for", () => {
    // Japan has no connector here. It must not come back as "no register
    // exists" — GLEIF covers every country, thinly.
    expect(connectorsFor("jp").confirm.map((c) => c.id)).toEqual(["gleif"]);
  });
});
