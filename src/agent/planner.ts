import { RequestInput } from "../schemas/request";
import { ParsedPlan } from "./interpretation";
import { GroupByDimension, PlanStatus, QueryPlan, TRIAL_PHASES } from "../types";

/**
 * Reconcile the LLM/fallback plan with caller-supplied structured fields and
 * enforce internal consistency. Caller fields always win over inference. This is
 * the validation/constraint layer that keeps malformed plans from reaching the
 * executor (rubric: "include validation or constraints").
 */
export function finalizePlan(parsed: ParsedPlan, input: RequestInput): {
  plan: QueryPlan;
  warnings: string[];
} {
  const warnings: string[] = [];
  const filters = { ...parsed.filters };

  // 1. Caller-supplied structured fields override inferred filters.
  if (input.drug_name) filters.intervention = input.drug_name;
  if (input.condition) filters.condition = input.condition;
  if (input.sponsor) filters.sponsor = input.sponsor;
  if (input.country) filters.location = input.country;
  if (input.study_type) filters.studyType = input.study_type;
  if (input.status) filters.status = input.status;
  if (input.trial_phase) {
    filters.phase = Array.isArray(input.trial_phase)
      ? input.trial_phase
      : [input.trial_phase];
  }
  if (typeof input.start_year === "number") filters.startYearMin = input.start_year;
  if (typeof input.end_year === "number") filters.startYearMax = input.end_year;

  // 2. Sanity-check year range.
  if (
    typeof filters.startYearMin === "number" &&
    typeof filters.startYearMax === "number" &&
    filters.startYearMin > filters.startYearMax
  ) {
    warnings.push("start_year > end_year; swapped them.");
    [filters.startYearMin, filters.startYearMax] = [
      filters.startYearMax,
      filters.startYearMin,
    ];
  }

  // 3. Validate phases against the controlled vocabulary.
  if (filters.phase) {
    const valid = filters.phase.filter((p) => (TRIAL_PHASES as readonly string[]).includes(p));
    if (valid.length !== filters.phase.length) {
      warnings.push("Dropped unrecognized phase value(s).");
    }
    filters.phase = valid.length ? valid : undefined;
  }

  // A caller forcing visualization_type implicitly asserts the question is answerable.
  let status: PlanStatus = input.visualization_type ? "ok" : parsed.status;

  // Deterministic guard: an "ok" plan with NO filter at all matches the entire
  // registry (~600k trials). That is both too vague to be meaningful and a
  // runaway fetch, so downgrade to needs_clarification. Comparison queries carry
  // their entities in comparison.values (applied as per-series filters), so they
  // are exempt.
  const hasFilter = Boolean(
    filters.condition ||
      filters.intervention ||
      filters.sponsor ||
      filters.location ||
      filters.term ||
      filters.phase?.length ||
      filters.status?.length ||
      filters.studyType ||
      typeof filters.startYearMin === "number" ||
      typeof filters.startYearMax === "number",
  );
  const hasComparison = (parsed.comparison?.values?.length ?? 0) >= 2;
  let clarifyNote = parsed.notes;
  if (status === "ok" && !hasFilter && !hasComparison) {
    status = "needs_clarification";
    clarifyNote =
      "Question is too broad to query (it would match the entire registry). Please specify at least one of: condition, drug, sponsor, country, or a year range.";
  }

  // Not answerable as a chart: return a no-viz plan carrying the explanation.
  if (status !== "ok") {
    return {
      plan: {
        status,
        visualizationType: "bar_chart", // placeholder; unused when status !== "ok"
        filters,
        title: parsed.title,
        notes: clarifyNote,
        confidence: parsed.confidence,
      },
      warnings,
    };
  }

  let visualizationType = input.visualization_type ?? parsed.visualizationType ?? "bar_chart";
  let groupBy = parsed.groupBy;
  let comparison = parsed.comparison;
  let network = parsed.network;
  let scatter = parsed.scatter;
  let histogram = parsed.histogram;

  // 4. Per-viz-type structural requirements & sensible defaults.
  switch (visualizationType) {
    case "time_series":
      groupBy = "year";
      break;

    case "grouped_bar_chart":
      if (!comparison || comparison.values.length < 2) {
        warnings.push(
          "grouped_bar_chart requested without a valid 2+ value comparison; downgraded to bar_chart.",
        );
        visualizationType = "bar_chart";
        groupBy = groupBy ?? "phase";
      } else {
        groupBy = groupBy ?? "phase"; // sub-grouping dimension within each series.
      }
      break;

    case "network_graph":
      if (!network) {
        network = { source: "sponsor", target: "drug" };
        warnings.push("network_graph requested without entities; defaulted to sponsor↔drug.");
      }
      groupBy = undefined;
      break;

    case "scatter_plot":
      if (!scatter) {
        scatter = { x: "start_year", y: "enrollment" };
        warnings.push("scatter_plot requested without axes; defaulted to start_year vs enrollment.");
      }
      groupBy = undefined;
      break;

    case "histogram":
      if (!histogram) {
        histogram = { field: "enrollment" };
        warnings.push("histogram requested without a field; defaulted to enrollment.");
      }
      groupBy = undefined;
      break;

    case "bar_chart":
    default:
      groupBy = groupBy ?? "phase";
      break;
  }

  // 5. Ranking (sort/topN) — only meaningful for bar_chart over an unordered
  //    category. Ignored for other viz types and for phase (which is inherently
  //    ordered → always chronological, never ranked).
  let sort = parsed.sort;
  let topN = parsed.topN;
  if (visualizationType !== "bar_chart") {
    if (sort || topN)
      warnings.push(`sort/topN ignored for ${visualizationType} (ranking applies to bar_chart only).`);
    sort = undefined;
    topN = undefined;
  } else if (groupBy === "phase") {
    sort = undefined;
    topN = undefined;
  } else if (typeof topN === "number") {
    topN = Math.min(Math.max(Math.trunc(topN), 1), 100); // clamp to [1,100]
  }

  const plan: QueryPlan = {
    status,
    visualizationType,
    filters,
    groupBy: groupBy as GroupByDimension | undefined,
    sort,
    topN,
    comparison,
    network,
    scatter,
    histogram,
    title: parsed.title,
    notes: parsed.notes,
    confidence: parsed.confidence,
  };

  return { plan, warnings };
}
