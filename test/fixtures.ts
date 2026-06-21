import { NormalizedStudy } from "../src/types";

/** Build a NormalizedStudy with sensible defaults; override any field per test. */
export function study(overrides: Partial<NormalizedStudy> = {}): NormalizedStudy {
  return {
    nctId: "NCT00000001",
    briefTitle: "A trial",
    officialTitle: "An official trial title",
    investigator: null,
    phases: ["PHASE2"],
    studyType: "INTERVENTIONAL",
    overallStatus: "RECRUITING",
    startDate: "2020-05-01",
    startYear: 2020,
    leadSponsor: "Acme",
    sponsorClass: "INDUSTRY",
    conditions: ["Melanoma"],
    interventions: [{ type: "DRUG", name: "DrugA" }],
    countries: ["United States"],
    enrollment: 100,
    ...overrides,
  };
}
