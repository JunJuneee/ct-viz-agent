import { describe, it, expect } from "vitest";
import { fallbackInterpret } from "../src/agent/fallback";

describe("fallbackInterpret (no-LLM keyword parser)", () => {
  it("detects time-trend phrasing", () => {
    const p = fallbackInterpret("How many melanoma trials per year?");
    expect(p.visualizationType).toBe("time_series");
    expect(p.groupBy).toBe("year");
  });

  it("detects an 'A vs B' comparison and extracts the two entities", () => {
    const p = fallbackInterpret("Compare phases for Pembrolizumab vs Nivolumab");
    expect(p.visualizationType).toBe("grouped_bar_chart");
    expect(p.comparison?.values).toEqual(["Pembrolizumab", "Nivolumab"]);
  });

  it("detects geographic phrasing", () => {
    expect(fallbackInterpret("which countries run these trials").groupBy).toBe("country");
  });

  it("detects enrollment → histogram", () => {
    expect(fallbackInterpret("enrollment size distribution").visualizationType).toBe("histogram");
  });

  it("detects network phrasing", () => {
    expect(fallbackInterpret("sponsor drug network").visualizationType).toBe("network_graph");
  });

  it("extracts ranking direction and topN for bar charts", () => {
    const most = fallbackInterpret("which countries have the most trials");
    expect(most.sort).toBe("desc");
    expect(most.topN).toBe(10);
    const top5 = fallbackInterpret("top 5 sponsors");
    expect(top5.sort).toBe("desc");
    expect(top5.topN).toBe(5);
    const fewest = fallbackInterpret("countries with the fewest trials");
    expect(fewest.sort).toBe("asc");
  });

  it("defaults to a phase bar chart and always reports status ok with low confidence", () => {
    const p = fallbackInterpret("something about trials");
    expect(p.visualizationType).toBe("bar_chart");
    expect(p.groupBy).toBe("phase");
    expect(p.status).toBe("ok");
    expect(p.confidence).toBeLessThan(0.6);
  });
});
