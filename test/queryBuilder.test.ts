import { describe, it, expect } from "vitest";
import { buildQueryParams } from "../src/agent/queryBuilder";

describe("buildQueryParams", () => {
  it("maps text filters to dedicated query.* params", () => {
    const p = buildQueryParams({
      condition: "melanoma",
      intervention: "Pembrolizumab",
      sponsor: "Merck",
      location: "Korea",
    });
    expect(p["query.cond"]).toBe("melanoma");
    expect(p["query.intr"]).toBe("Pembrolizumab");
    expect(p["query.spons"]).toBe("Merck");
    expect(p["query.locn"]).toBe("Korea");
  });

  it("builds an Essie phase expression with OR", () => {
    const p = buildQueryParams({ phase: ["PHASE2", "PHASE3"] });
    expect(p["filter.advanced"]).toBe("AREA[Phase](PHASE2 OR PHASE3)");
  });

  it("combines phase, studyType and date range with AND", () => {
    const p = buildQueryParams({
      phase: ["PHASE3"],
      studyType: "interventional",
      startYearMin: 2015,
      startYearMax: 2020,
    });
    expect(p["filter.advanced"]).toBe(
      "AREA[Phase](PHASE3) AND AREA[StudyType]INTERVENTIONAL AND AREA[StartDate]RANGE[2015-01-01,2020-12-31]",
    );
  });

  it("uses MIN/MAX sentinels for open-ended date ranges", () => {
    expect(buildQueryParams({ startYearMin: 2018 })["filter.advanced"]).toBe(
      "AREA[StartDate]RANGE[2018-01-01,MAX]",
    );
    expect(buildQueryParams({ startYearMax: 2022 })["filter.advanced"]).toBe(
      "AREA[StartDate]RANGE[MIN,2022-12-31]",
    );
  });

  it("maps status to the dedicated overallStatus param (uppercased, comma-joined)", () => {
    const p = buildQueryParams({ status: ["recruiting", "completed"] });
    expect(p["filter.overallStatus"]).toBe("RECRUITING,COMPLETED");
    expect(p["filter.advanced"]).toBeUndefined();
  });

  it("produces no params for empty filters", () => {
    expect(buildQueryParams({})).toEqual({});
  });
});
