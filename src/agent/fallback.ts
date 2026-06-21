import { ParsedPlan } from "./interpretation";
import {
  GroupByDimension,
  NetworkEntity,
  SortDirection,
  VisualizationType,
} from "../types";

/**
 * Deterministic keyword-based interpreter used when no OpenAI key is configured
 * (or as a safety net if the LLM call fails). It is intentionally conservative:
 * it recognises the documented query families and otherwise defaults to a
 * phase-distribution bar chart. This keeps the service runnable with zero config.
 */
export function fallbackInterpret(query: string): ParsedPlan {
  const q = query.toLowerCase();

  const has = (...words: string[]): boolean => words.some((w) => q.includes(w));

  let visualizationType: VisualizationType = "bar_chart";
  let groupBy: GroupByDimension | undefined = "phase";
  let network: { source: NetworkEntity; target: NetworkEntity } | undefined;
  let histogram: ParsedPlan["histogram"];
  let scatter: ParsedPlan["scatter"];

  // Comparisons ("A vs B") --------------------------------------------------
  // Deterministically extract the two entities around "vs"/"versus".
  const vsValues = extractComparison(query);
  if (vsValues) {
    return {
      status: "ok",
      visualizationType: "grouped_bar_chart",
      filters: {},
      groupBy: "phase",
      comparison: { dimension: "intervention", values: vsValues },
      title: `Phase comparison: ${vsValues.join(" vs ")}`,
      notes:
        "Interpreted with the deterministic fallback parser (detected an 'A vs B' comparison).",
      confidence: 0.45,
    };
  }

  // Time trends -------------------------------------------------------------
  if (has("over time", "per year", "each year", "since ", "trend", "by year", "yearly")) {
    visualizationType = "time_series";
    groupBy = "year";
  }
  // Relationships / networks ------------------------------------------------
  else if (has("network", "co-occur", "cooccur", "relationship", "combination", "↔")) {
    visualizationType = "network_graph";
    groupBy = undefined;
    if (has("sponsor")) network = { source: "sponsor", target: "drug" };
    else network = { source: "drug", target: "drug" };
  }
  // Geographic --------------------------------------------------------------
  else if (has("country", "countries", "geograph", "location", "where")) {
    visualizationType = "bar_chart";
    groupBy = "country";
  }
  // Enrollment distribution -> histogram ------------------------------------
  else if (has("enrollment", "participants", "sample size", "how large", "how big")) {
    visualizationType = "histogram";
    groupBy = undefined;
    histogram = { field: "enrollment" };
  }
  // Intervention-type distribution ------------------------------------------
  else if (has("intervention type", "type of intervention", "types of intervention")) {
    visualizationType = "bar_chart";
    groupBy = "intervention_type";
  }
  // Sponsor distribution ----------------------------------------------------
  else if (has("sponsor", "funder", "who funds", "who sponsors")) {
    visualizationType = "bar_chart";
    groupBy = "sponsor";
  }
  // Status distribution -----------------------------------------------------
  else if (has("status", "recruiting", "completed", "ongoing")) {
    visualizationType = "bar_chart";
    groupBy = "status";
  }
  // Phases / distribution (default) -----------------------------------------
  else if (has("phase", "distribut", "across phases")) {
    visualizationType = "bar_chart";
    groupBy = "phase";
  }

  // Ranking ("most/top/fewest/least") — only meaningful for bar charts.
  const ranking = visualizationType === "bar_chart" ? extractRanking(q) : {};

  return {
    status: "ok",
    visualizationType,
    filters: {},
    groupBy,
    sort: ranking.sort,
    topN: ranking.topN,
    network,
    histogram,
    scatter,
    title: "Clinical Trials Visualization",
    notes:
      "Interpreted with the deterministic fallback parser (no LLM). Provide structured fields (drug_name, condition, …) for best accuracy.",
    confidence: 0.4,
  };
}

/**
 * Detect ranking intent from "most/top/highest" (desc) or "fewest/least/lowest"
 * (asc), plus an explicit "top N" cutoff. Returns empty when no ranking is implied.
 */
function extractRanking(q: string): { sort?: SortDirection; topN?: number } {
  const asc = /\b(fewest|least|lowest|smallest)\b/.test(q);
  const desc = /\b(most|top|highest|largest|biggest|leading)\b/.test(q);
  if (!asc && !desc) return {};
  const m = /\btop\s+(\d{1,3})\b/.exec(q);
  const topN = m ? Math.min(Number.parseInt(m[1], 10), 100) : 10;
  return { sort: asc ? "asc" : "desc", topN };
}

/**
 * Detect an "A vs B" / "A versus B" comparison and return the two entity strings.
 * Grabs the capitalized phrase immediately before and after the separator, which
 * reliably captures drug/condition names without an LLM.
 */
function extractComparison(query: string): [string, string] | null {
  const m = /\b(?:vs\.?|versus)\b/i.exec(query);
  if (!m) return null;

  const left = query.slice(0, m.index).trim();
  const right = query.slice(m.index + m[0].length).trim();

  const a = lastEntity(left);
  const b = firstEntity(right);
  return a && b ? [a, b] : null;
}

// Last run of Capitalized words at the end of a string.
function lastEntity(s: string): string | null {
  const m = /([A-Z][\w-]*(?:\s+[A-Z][\w-]*)*)\s*$/.exec(s);
  return m ? m[1].trim() : null;
}

// First run of Capitalized words at the start of a string (strips trailing punctuation).
function firstEntity(s: string): string | null {
  const m = /^([A-Z][\w-]*(?:\s+[A-Z][\w-]*)*)/.exec(s.replace(/^[^A-Za-z]+/, ""));
  return m ? m[1].trim() : null;
}
