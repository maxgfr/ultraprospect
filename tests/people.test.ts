// Who is named on a company's own pages, and what they do there.
//
// Every fixture in this file is a phrasing MEASURED on a real Hamburg sweep,
// including the traps. The traps are the point: a role label is easy to find
// and the thing after it is very often not a person.
import { describe, expect, it } from "vitest";
import { extractPeople } from "../src/people.js";

const de = (text: string, over: Partial<Parameters<typeof extractPeople>[1]> = {}) => extractPeople(text, { countryCode: "de", ...over });

describe("extractPeople", () => {
  it("reads the label-then-name form a legal notice is required to use", () => {
    // Observed verbatim: "Vertreten durch: René Schuch".
    expect(de("Vertreten durch: René Schuch")).toEqual([{ value: "René Schuch", role: "Vertreten durch" }]);
  });

  it("takes every name in a list, because a GmbH can have three", () => {
    // Observed verbatim: "Geschäftsführer : Chris Kahlefendt, Pascal Loth, Finn Poppinga".
    expect(de("Geschäftsführer : Chris Kahlefendt, Pascal Loth, Finn Poppinga").map((p) => p.value)).toEqual([
      "Chris Kahlefendt",
      "Pascal Loth",
      "Finn Poppinga",
    ]);
  });

  it("refuses a company sitting where the name should be", () => {
    // Observed verbatim, and the trap this module exists for: a role label
    // followed by a legal entity. "Geschäftsführer • AFFILITIX Services GmbH"
    // names the company somebody directs, not a person.
    expect(de("Geschäftsführer • AFFILITIX Services GmbH")).toEqual([]);
    expect(de("Geschäftsführer – dreamIT")).toEqual([]);
    expect(de("Geschäftsführer • HKH Hamburger Küche & Heimkost GmbH")).toEqual([]);
  });

  it("refuses prose that merely contains the word", () => {
    // Observed verbatim: "Geschäftsführer an Bord, wodurch neben Handel und
    // Kanzleien auch die Hotellerie". A label is not a claim that a name follows.
    expect(de("Geschäftsführer an Bord, wodurch neben Handel und Kanzleien auch die Hotellerie")).toEqual([]);
    expect(de("Geschäftsführer & technischer Lead")).toEqual([]);
  });

  it("reads the name-then-role form a team page uses", () => {
    expect(de("Anna Müller\nHead of Engineering\n").map((p) => p.value)).toEqual(["Anna Müller"]);
    expect(de("Dominique Bremer\nHead of People & Culture")[0]!.role).toContain("Head of");
  });

  it("works in the market's own language, not only in German", () => {
    expect(extractPeople("Gérant : Jean Dupont", { countryCode: "fr" })[0]).toEqual({ value: "Jean Dupont", role: "Gérant" });
    expect(extractPeople("Administrador: Carlos Ruiz", { countryCode: "es" })[0]?.value).toBe("Carlos Ruiz");
    expect(extractPeople("Managing Director: Sarah Connor", { countryCode: "gb" })[0]?.value).toBe("Sarah Connor");
  });

  it("reads an English title on a site that is not English", () => {
    // German SMEs write "CEO" and "Head of Sales" on their own team pages. A
    // vocabulary keyed only on the country language misses them.
    expect(de("Vertreten durch: Lars Peters\nCEO: Marta Nowak").map((p) => p.value)).toContain("Marta Nowak");
  });

  it("never returns the company itself, however it is written", () => {
    expect(de("Geschäftsführer: Nord Nord Media", { companyName: "NORD.NORD Media GmbH" })).toEqual([]);
  });

  it("refuses page furniture and place names standing in for a person", () => {
    expect(de("Geschäftsführer: Impressum Kontakt")).toEqual([]);
    expect(de("Geschäftsführer: Hamburg Altona", { town: "Hamburg" })).toEqual([]);
  });

  it("refuses anything carrying a digit or an address", () => {
    expect(de("Geschäftsführer: Musterstraße 12")).toEqual([]);
    expect(de("Geschäftsführer: info@acme.de")).toEqual([]);
  });

  it("does not report the same person twice from one page", () => {
    const twice = de("Vertreten durch: René Schuch\nGeschäftsführer: René Schuch");
    expect(twice).toHaveLength(1);
  });

  it("caps what one page can contribute", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Geschäftsführer: Anna Nummer${String.fromCharCode(65 + (i % 26))}`).join("\n");
    expect(de(many).length).toBeLessThanOrEqual(12);
  });
});
