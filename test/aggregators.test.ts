import { describe, it, expect } from "vitest";
import {
  countByDimension,
  timeSeries,
  histogram,
} from "../src/aggregate/aggregators";
import { study } from "./fixtures";

describe("countByDimension", () => {
  const studies = [
    study({ nctId: "N1", leadSponsor: "A" }),
    study({ nctId: "N2", leadSponsor: "A" }),
    study({ nctId: "N3", leadSponsor: "B" }),
    study({ nctId: "N4", leadSponsor: "C" }),
    study({ nctId: "N5", leadSponsor: "C" }),
    study({ nctId: "N6", leadSponsor: "C" }),
  ];

  it("counts and sorts descending by default", () => {
    const { data } = countByDimension(studies, "sponsor");
    expect(data.map((d) => [d.category, d.trial_count])).toEqual([
      ["C", 3],
      ["A", 2],
      ["B", 1],
    ]);
  });

  it("sorts ascending when sortDir=asc (fewest first)", () => {
    const { data } = countByDimension(studies, "sponsor", { sortDir: "asc" });
    expect(data[0].category).toBe("B");
    expect(data[0].trial_count).toBe(1);
  });

  it("applies topN and reports truncatedCategories", () => {
    const res = countByDimension(studies, "sponsor", { topN: 1 });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].category).toBe("C");
    expect(res.truncatedCategories).toBe(2);
  });

  it("counts a study once per category for multi-valued dimensions (phase)", () => {
    const s = [study({ nctId: "M1", phases: ["PHASE1", "PHASE2"] })];
    const { data } = countByDimension(s, "phase");
    const labels = data.map((d) => d.category).sort();
    expect(labels).toEqual(["Phase 1", "Phase 2"]);
  });

  it("attaches citations to each datum", () => {
    const { data } = countByDimension(studies, "sponsor");
    expect(data[0].citations?.[0].nct_id).toBeTruthy();
    expect(data[0].citations?.[0].url).toContain("clinicaltrials.gov/study/");
  });
});

describe("timeSeries", () => {
  it("buckets by start year and gap-fills missing years with zero", () => {
    const studies = [
      study({ nctId: "N1", startYear: 2018, startDate: "2018-01-01" }),
      study({ nctId: "N2", startYear: 2020, startDate: "2020-01-01" }),
    ];
    const { data } = timeSeries(studies);
    expect(data.map((d) => d.year)).toEqual([2018, 2019, 2020]);
    expect(data.map((d) => d.trial_count)).toEqual([1, 0, 1]);
  });

  it("counts studies missing a start year as skipped", () => {
    const { skipped } = timeSeries([study({ startYear: null })]);
    expect(skipped).toBe(1);
  });
});

describe("histogram", () => {
  it("buckets a numeric field and counts per bucket", () => {
    const studies = [
      study({ nctId: "N1", enrollment: 5 }),
      study({ nctId: "N2", enrollment: 7 }),
      study({ nctId: "N3", enrollment: 5000 }),
    ];
    const { data } = histogram(studies, "enrollment", 10);
    const first = data.find((d) => d.bucket_start === 0)!;
    expect(first.trial_count).toBe(2); // 5 and 7 land in 0-9
    expect(data.reduce((n, d) => n + (d.trial_count as number), 0)).toBe(3);
  });

  it("skips records without the numeric field", () => {
    const { skipped } = histogram([study({ enrollment: null })], "enrollment");
    expect(skipped).toBe(1);
  });
});
