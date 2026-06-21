import { describe, it, expect } from "vitest";
import { finalizePlan } from "../src/agent/planner";
import { QueryPlanSchema, ParsedPlan } from "../src/agent/interpretation";
import { RequestSchema } from "../src/schemas/request";

const parse = (o: Record<string, unknown>): ParsedPlan =>
  QueryPlanSchema.parse(o) as ParsedPlan;
const req = (o: Record<string, unknown>) => RequestSchema.parse(o);

describe("finalizePlan — status gate", () => {
  it("passes through unsupported with no chart", () => {
    const { plan } = finalizePlan(
      parse({ status: "unsupported", title: "x", confidence: 0.9, notes: "out of scope" }),
      req({ query: "weather tomorrow?" }),
    );
    expect(plan.status).toBe("unsupported");
  });

  it("downgrades a zero-filter ok plan to needs_clarification", () => {
    const { plan } = finalizePlan(
      parse({ status: "ok", visualizationType: "bar_chart", title: "x", confidence: 0.5 }),
      req({ query: "show me trials" }),
    );
    expect(plan.status).toBe("needs_clarification");
    expect(plan.notes).toMatch(/too broad/i);
  });

  it("keeps ok when at least one filter is present", () => {
    const { plan } = finalizePlan(
      parse({ status: "ok", visualizationType: "bar_chart", filters: { condition: "melanoma" }, title: "x", confidence: 0.9 }),
      req({ query: "melanoma by phase" }),
    );
    expect(plan.status).toBe("ok");
    expect(plan.filters.condition).toBe("melanoma");
  });

  it("comparison with 2+ values is exempt from the empty-filter guard", () => {
    const { plan } = finalizePlan(
      parse({
        status: "ok",
        visualizationType: "grouped_bar_chart",
        comparison: { dimension: "intervention", values: ["A", "B"] },
        title: "x",
        confidence: 0.8,
      }),
      req({ query: "A vs B" }),
    );
    expect(plan.status).toBe("ok");
    expect(plan.visualizationType).toBe("grouped_bar_chart");
  });
});

describe("finalizePlan — caller overrides & constraints", () => {
  it("caller structured fields override inferred filters", () => {
    const { plan } = finalizePlan(
      parse({ status: "ok", visualizationType: "time_series", filters: { intervention: "Keytruda" }, title: "x", confidence: 0.9 }),
      req({ query: "trend for Keytruda", drug_name: "Pembrolizumab" }),
    );
    expect(plan.filters.intervention).toBe("Pembrolizumab");
  });

  it("forces groupBy=year for time_series", () => {
    const { plan } = finalizePlan(
      parse({ status: "ok", visualizationType: "time_series", filters: { condition: "melanoma" }, title: "x", confidence: 0.9 }),
      req({ query: "melanoma per year" }),
    );
    expect(plan.groupBy).toBe("year");
  });

  it("downgrades grouped_bar_chart without a valid comparison to bar_chart", () => {
    const { plan, warnings } = finalizePlan(
      parse({ status: "ok", visualizationType: "grouped_bar_chart", filters: { condition: "melanoma" }, title: "x", confidence: 0.7 }),
      req({ query: "melanoma" }),
    );
    expect(plan.visualizationType).toBe("bar_chart");
    expect(warnings.join(" ")).toMatch(/grouped_bar_chart/);
  });
});

describe("finalizePlan — ranking", () => {
  it("keeps sort/topN for a non-phase bar chart", () => {
    const { plan } = finalizePlan(
      parse({ status: "ok", visualizationType: "bar_chart", groupBy: "country", filters: { condition: "melanoma" }, sort: "desc", topN: 5, title: "x", confidence: 0.9 }),
      req({ query: "top 5 countries for melanoma" }),
    );
    expect(plan.sort).toBe("desc");
    expect(plan.topN).toBe(5);
  });

  it("drops sort/topN for phase (chronological order)", () => {
    const { plan } = finalizePlan(
      parse({ status: "ok", visualizationType: "bar_chart", groupBy: "phase", filters: { condition: "melanoma" }, sort: "desc", topN: 10, title: "x", confidence: 0.9 }),
      req({ query: "which phase has the most melanoma trials" }),
    );
    expect(plan.sort).toBeUndefined();
    expect(plan.topN).toBeUndefined();
  });

  it("preserves topN at the schema boundary (100)", () => {
    // The schema caps topN at 100, and the planner clamps defensively; a valid
    // boundary value must survive unchanged.
    const { plan } = finalizePlan(
      parse({ status: "ok", visualizationType: "bar_chart", groupBy: "sponsor", filters: { condition: "x" }, sort: "desc", topN: 100, title: "x", confidence: 0.9 }),
      req({ query: "top sponsors" }),
    );
    expect(plan.topN).toBe(100);
  });
});
