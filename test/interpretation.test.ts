import { describe, it, expect } from "vitest";
import { QueryPlanSchema } from "../src/agent/interpretation";

describe("QueryPlanSchema (stripEmpty + validation)", () => {
  it("strips an empty-string enum so unsupported plans validate", () => {
    // Models often emit visualizationType:"" when status != ok.
    const plan = QueryPlanSchema.parse({
      status: "unsupported",
      visualizationType: "",
      title: "x",
      confidence: 0.9,
    }) as { visualizationType?: string };
    expect(plan.visualizationType).toBeUndefined();
  });

  it("drops a blank/placeholder sub-object (e.g. scatter:{x:'',y:''})", () => {
    const plan = QueryPlanSchema.parse({
      status: "ok",
      visualizationType: "bar_chart",
      scatter: { x: "", y: "" },
      filters: { condition: "melanoma" },
      title: "x",
      confidence: 0.9,
    }) as { scatter?: unknown };
    expect(plan.scatter).toBeUndefined();
  });

  it("applies defaults for status/filters/title/confidence", () => {
    const plan = QueryPlanSchema.parse({}) as {
      status: string;
      filters: object;
      confidence: number;
    };
    expect(plan.status).toBe("ok");
    expect(plan.filters).toEqual({});
    expect(typeof plan.confidence).toBe("number");
  });

  it("rejects a genuinely invalid enum value", () => {
    expect(() =>
      QueryPlanSchema.parse({ status: "ok", visualizationType: "pie_chart", title: "x", confidence: 1 }),
    ).toThrow();
  });

  it("keeps valid ranking fields", () => {
    const plan = QueryPlanSchema.parse({
      status: "ok",
      visualizationType: "bar_chart",
      sort: "desc",
      topN: 5,
      title: "x",
      confidence: 0.9,
    }) as { sort?: string; topN?: number };
    expect(plan.sort).toBe("desc");
    expect(plan.topN).toBe(5);
  });
});
