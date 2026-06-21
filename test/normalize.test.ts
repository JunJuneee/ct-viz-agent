import { describe, it, expect } from "vitest";
import { normalizeStudy, normalizeStudies } from "../src/clinicaltrials/normalize";
import { RawStudy } from "../src/clinicaltrials/client";

const raw: RawStudy = {
  protocolSection: {
    identificationModule: {
      nctId: "NCT02068196",
      briefTitle: "Brief title",
      officialTitle: "Official title",
    },
    statusModule: { overallStatus: "COMPLETED", startDateStruct: { date: "2023-03-24" } },
    designModule: { phases: ["PHASE4"], studyType: "INTERVENTIONAL", enrollmentInfo: { count: 42 } },
    sponsorCollaboratorsModule: {
      leadSponsor: { name: "Oslo University Hospital", class: "OTHER" },
      responsibleParty: { investigatorFullName: "Tormod Kyrre Guren, MD" },
    },
    conditionsModule: { conditions: ["Melanoma"] },
    armsInterventionsModule: { interventions: [{ type: "DRUG", name: "Ipilimumab" }] },
    contactsLocationsModule: {
      locations: [
        { country: "Norway", city: "Oslo" },
        { country: "Norway", city: "Bergen" }, // duplicate country
        { country: "Sweden", city: "Lund" },
      ],
    },
  },
};

describe("normalizeStudy", () => {
  it("flattens fields and derives startYear", () => {
    const s = normalizeStudy(raw)!;
    expect(s.nctId).toBe("NCT02068196");
    expect(s.officialTitle).toBe("Official title");
    expect(s.investigator).toBe("Tormod Kyrre Guren, MD");
    expect(s.startYear).toBe(2023);
    expect(s.enrollment).toBe(42);
    expect(s.leadSponsor).toBe("Oslo University Hospital");
  });

  it("dedupes countries", () => {
    const s = normalizeStudy(raw)!;
    expect(s.countries).toEqual(["Norway", "Sweden"]);
  });

  it("drops records without an nctId (must be traceable)", () => {
    expect(normalizeStudy({ protocolSection: {} })).toBeNull();
  });

  it("handles missing optional fields with nulls/empties", () => {
    const s = normalizeStudy({
      protocolSection: { identificationModule: { nctId: "NCT1" } },
    })!;
    expect(s.startYear).toBeNull();
    expect(s.enrollment).toBeNull();
    expect(s.investigator).toBeNull();
    expect(s.countries).toEqual([]);
    expect(s.phases).toEqual([]);
  });

  it("normalizeStudies filters out null records", () => {
    const out = normalizeStudies([raw, { protocolSection: {} }]);
    expect(out).toHaveLength(1);
  });
});
