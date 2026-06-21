import { RequestInput } from "./schemas/request";
import { langfuse, langfuseEnabled, recordEval } from "./lib/langfuse";
import { maybeJudge } from "./agent/judge";
import { withSpan } from "./otel";
import { interpretQuery } from "./agent/interpret";
import { finalizePlan } from "./agent/planner";
import { buildQueryParams } from "./agent/queryBuilder";
import { fetchStudies } from "./clinicaltrials/client";
import { STUDY_URL } from "./clinicaltrials/fields";
import { normalizeStudies } from "./clinicaltrials/normalize";
import {
  countByDimension,
  histogram,
  scatter,
  timeSeries,
} from "./aggregate/aggregators";
import { buildNetwork } from "./aggregate/network";
import { dimensionLabel, numericLabel } from "./aggregate/dimensions";
import {
  AgentResponse,
  ComparisonDimension,
  Encoding,
  GroupByDimension,
  NormalizedStudy,
  PlanFilters,
  QueryPlan,
  Reference,
  VisualizationSpec,
  VizDatum,
} from "./types";

/**
 * Progress events streamed to the client (via SSE). Lets the UI show the LLM's
 * interpretation (plan + notes) and live fetch progress before the final result.
 */
export type AgentEvent =
  | { type: "status"; message: string }
  | {
      type: "interpretation";
      interpreter: "llm" | "fallback-rules";
      queryPlan: QueryPlan;
      notes?: string;
      confidence: number;
      warnings?: string[];
    }
  | { type: "fetch_progress"; fetched: number; total: number; page: number }
  | { type: "result"; response: AgentResponse }
  | { type: "error"; message: string };

type EmitFn = (e: AgentEvent) => void;

/**
 * Full agent pipeline: interpret the question, validate the plan, fetch real
 * records from ClinicalTrials.gov, aggregate deterministically, and assemble a
 * frontend-ready visualization specification with deep citations.
 *
 * Pass `emit` to receive streaming progress events (used by the SSE endpoint);
 * omit it for a plain request/response call.
 */
export async function runAgent(
  input: RequestInput,
  emit?: EmitFn,
): Promise<AgentResponse> {
  // One Langfuse trace per request; the interpret LLM call nests under it as a
  // generation (token/cost/latency auto-captured). No-op when keys are unset.
  const trace = langfuseEnabled
    ? langfuse.trace({ name: "query", input })
    : undefined;

  emit?.({ type: "status", message: "Interpreting your question…" });
  const interp = await withSpan("interpret", () => interpretQuery(input, trace));
  const { plan, warnings: planWarnings } = finalizePlan(interp.plan, input);
  const warnings = [...interp.warnings, ...planWarnings];
  const interpreter = interp.interpreter === "llm" ? "llm" : "fallback-rules";

  emit?.({
    type: "interpretation",
    interpreter,
    queryPlan: plan,
    notes: plan.notes,
    confidence: plan.confidence,
    warnings: warnings.length ? warnings : undefined,
  });

  // Not answerable as a chart (out of scope / too vague): return early with no
  // visualization and an explanation — never force a misleading chart.
  if (plan.status !== "ok") {
    const response: AgentResponse = {
      visualization: null,
      meta: {
        source: "clinicaltrials.gov",
        apiVersion: "v2",
        filters: plan.filters,
        totalMatchingTrials: 0,
        analyzedTrials: 0,
        truncated: false,
        units: "n/a",
        sort: "n/a",
        notes: plan.notes,
        confidence: plan.confidence,
        status: plan.status,
        interpreter,
        apiRequests: [],
        warnings: warnings.length ? warnings : undefined,
      },
      references: [],
      trace: {
        queryPlan: plan,
        interpreter,
        apiRequests: [],
        apiTotalCount: 0,
        apiResponseSample: [],
      },
    };
    recordEval(trace, response);
    void maybeJudge(input, response, trace); // async LLM-as-judge (sampled), non-blocking
    emit?.({ type: "result", response });
    return response;
  }

  emit?.({ type: "status", message: "Querying ClinicalTrials.gov (fetching all matches)…" });
  const { visualization, totals, apiRequests, extraWarnings, rawSample, references } =
    await withSpan("execute_plan", () => executePlan(plan, emit), {
      "viz.type": plan.visualizationType,
    });
  warnings.push(...extraWarnings);
  emit?.({ type: "status", message: "Aggregating results…" });

  const response: AgentResponse = {
    visualization,
    meta: {
      source: "clinicaltrials.gov",
      apiVersion: "v2",
      filters: plan.filters,
      totalMatchingTrials: totals.totalMatching,
      analyzedTrials: totals.analyzed,
      truncated: totals.truncated,
      groupBy: plan.groupBy,
      units: unitsFor(plan),
      sort: sortFor(plan),
      notes: plan.notes,
      confidence: plan.confidence,
      status: plan.status,
      interpreter,
      apiRequests,
      warnings: warnings.length ? warnings : undefined,
    },
    references,
    trace: {
      queryPlan: plan,
      interpreter,
      apiRequests,
      apiTotalCount: totals.totalMatching,
      apiResponseSample: rawSample,
    },
  };

  // Online evaluation: attach deterministic quality metrics (no LLM judge).
  // Sent as Langfuse scores when enabled; logged to the console in dry-run.
  recordEval(trace, response);
  void maybeJudge(input, response, trace); // async LLM-as-judge (sampled), non-blocking

  emit?.({ type: "result", response });
  return response;
}

interface ExecOutput {
  visualization: VisualizationSpec;
  totals: { totalMatching: number; analyzed: number; truncated: boolean };
  apiRequests: string[];
  extraWarnings: string[];
  /** First few RAW API records, for the verification trace. */
  rawSample: unknown[];
  /** Rich source cards for every cited trial. */
  references: Reference[];
}

/**
 * Collect a deduplicated set of source cards for every trial cited anywhere in
 * the visualization (bar/line data points and network edges), looking up the
 * rich fields from the studies we already fetched.
 */
function collectReferences(
  viz: VisualizationSpec,
  studyMap: Map<string, NormalizedStudy>,
  cap = 60,
): Reference[] {
  const ids = new Set<string>();
  for (const d of viz.data ?? []) for (const c of d.citations ?? []) ids.add(c.nct_id);
  for (const e of viz.edges ?? []) for (const c of e.citations ?? []) ids.add(c.nct_id);

  const refs: Reference[] = [];
  for (const id of ids) {
    const s = studyMap.get(id);
    if (!s) continue;
    refs.push({
      nct_id: s.nctId,
      title: s.briefTitle,
      officialTitle: s.officialTitle,
      sponsor: s.leadSponsor,
      investigator: s.investigator,
      startDate: s.startDate,
      url: STUDY_URL(s.nctId),
    });
    if (refs.length >= cap) break;
  }
  return refs;
}

async function executePlan(plan: QueryPlan, emit?: EmitFn): Promise<ExecOutput> {
  if (plan.visualizationType === "grouped_bar_chart" && plan.comparison) {
    return executeComparison(plan, emit);
  }

  // Single-query path for all other visualization types.
  const params = buildQueryParams(plan.filters);
  const fetched = await fetchStudies(params, (p) =>
    emit?.({ type: "fetch_progress", fetched: p.fetched, total: p.total, page: p.page }),
  );
  const studies = normalizeStudies(fetched.studies);
  const apiRequests = fetched.requestUrls;
  const rawSample = fetched.studies.slice(0, 3); // first few RAW records for trace
  const extraWarnings: string[] = [];
  const totals = {
    totalMatching: fetched.totalCount,
    analyzed: studies.length,
    truncated: fetched.truncated,
  };

  let visualization: VisualizationSpec;

  switch (plan.visualizationType) {
    case "time_series": {
      const res = timeSeries(studies);
      noteSkipped(extraWarnings, res.skipped, "missing a start date");
      visualization = {
        type: "time_series",
        title: plan.title,
        encoding: {
          x: { field: "year", type: "temporal", label: "Year" },
          y: { field: "trial_count", type: "quantitative", label: "Trial Count" },
        },
        data: res.data,
      };
      break;
    }

    case "histogram": {
      const field = plan.histogram!.field;
      const res = histogram(studies, field, plan.histogram!.bucketSize);
      noteSkipped(extraWarnings, res.skipped, `missing ${numericLabel[field]}`);
      visualization = {
        type: "histogram",
        title: plan.title,
        encoding: {
          x: { field: "bucket", type: "ordinal", label: `${numericLabel[field]} range` },
          y: { field: "trial_count", type: "quantitative", label: "Trial Count" },
        },
        data: res.data,
      };
      break;
    }

    case "scatter_plot": {
      const { x, y } = plan.scatter!;
      const res = scatter(studies, x, y);
      noteSkipped(extraWarnings, res.skipped, "missing one of the axes");
      visualization = {
        type: "scatter_plot",
        title: plan.title,
        encoding: {
          x: { field: "x", type: "quantitative", label: numericLabel[x] },
          y: { field: "y", type: "quantitative", label: numericLabel[y] },
        },
        data: res.data,
      };
      break;
    }

    case "network_graph": {
      const { source, target } = plan.network!;
      const net = buildNetwork(studies, source, target);
      if (net.truncated)
        extraWarnings.push("Network truncated to the strongest edges for readability.");
      visualization = {
        type: "network_graph",
        title: plan.title,
        encoding: {
          nodes: { field: "id", label: "Entity" },
          edges: { field: "weight", label: "Shared trials" },
        },
        nodes: net.nodes,
        edges: net.edges,
      };
      break;
    }

    case "bar_chart":
    default: {
      const dim = (plan.groupBy ?? "phase") as GroupByDimension;
      const ranked = plan.sort !== undefined || plan.topN !== undefined;
      const res = countByDimension(studies, dim, {
        sortByKey: dim === "phase" && !ranked, // phase = chronological unless ranking asked
        sortDir: plan.sort,
        topN: plan.topN,
      });
      noteSkipped(extraWarnings, res.skipped, `missing ${dimensionLabel[dim]}`);
      if (res.truncatedCategories > 0)
        extraWarnings.push(
          `Showing top categories; ${res.truncatedCategories} smaller ${dimensionLabel[dim]} categories omitted.`,
        );
      visualization = {
        type: "bar_chart",
        title: plan.title,
        encoding: {
          x: { field: "category", type: "ordinal", label: dimensionLabel[dim] },
          y: { field: "trial_count", type: "quantitative", label: "Trial Count" },
        },
        data: res.data,
      };
      break;
    }
  }

  const studyMap = new Map(studies.map((s) => [s.nctId, s]));
  const references = collectReferences(visualization, studyMap);
  return { visualization, totals, apiRequests, extraWarnings, rawSample, references };
}

/**
 * Comparison path: run one API query per compared entity and merge the per-entity
 * counts into a single grouped-bar dataset (group = sub-dimension, series = entity).
 */
async function executeComparison(plan: QueryPlan, emit?: EmitFn): Promise<ExecOutput> {
  const comparison = plan.comparison!;
  const dim = (plan.groupBy ?? "phase") as GroupByDimension;
  const apiRequests: string[] = [];
  const extraWarnings: string[] = [];
  const data: VizDatum[] = [];
  const rawSample: unknown[] = [];
  const studyMap = new Map<string, NormalizedStudy>();
  let totalMatching = 0;
  let analyzed = 0;
  let truncated = false;

  for (const value of comparison.values) {
    const filters = applyComparisonValue(plan.filters, comparison.dimension, value);
    const params = buildQueryParams(filters);
    const fetched = await fetchStudies(params, (p) =>
      emit?.({ type: "fetch_progress", fetched: p.fetched, total: p.total, page: p.page }),
    );
    apiRequests.push(...fetched.requestUrls);
    if (rawSample.length < 3) rawSample.push(...fetched.studies.slice(0, 2));
    truncated = truncated || fetched.truncated;
    totalMatching += fetched.totalCount;

    const studies: NormalizedStudy[] = normalizeStudies(fetched.studies);
    for (const s of studies) studyMap.set(s.nctId, s);
    analyzed += studies.length;

    const res = countByDimension(studies, dim, { sortByKey: dim === "phase" });
    for (const d of res.data) {
      data.push({
        group: d.category,
        series: value,
        trial_count: d.trial_count,
        citations: d.citations,
      });
    }
  }

  const visualization: VisualizationSpec = {
    type: "grouped_bar_chart",
    title: plan.title,
    encoding: {
      x: { field: "group", type: "ordinal", label: dimensionLabel[dim] },
      y: { field: "trial_count", type: "quantitative", label: "Trial Count" },
      series: { field: "series", type: "nominal", label: comparisonLabel(comparison.dimension) },
    },
    data,
  };

  return {
    visualization,
    totals: { totalMatching, analyzed, truncated },
    apiRequests,
    extraWarnings,
    rawSample,
    references: collectReferences(visualization, studyMap),
  };
}

function applyComparisonValue(
  base: PlanFilters,
  dimension: ComparisonDimension,
  value: string,
): PlanFilters {
  const f = { ...base };
  if (dimension === "intervention") f.intervention = value;
  else if (dimension === "condition") f.condition = value;
  else if (dimension === "sponsor") f.sponsor = value;
  return f;
}

function comparisonLabel(d: ComparisonDimension): string {
  return d === "intervention" ? "Drug" : d === "condition" ? "Condition" : "Sponsor";
}

function noteSkipped(warnings: string[], skipped: number, reason: string): void {
  if (skipped > 0) warnings.push(`${skipped} trial(s) excluded for ${reason}.`);
}

function unitsFor(plan: QueryPlan): string {
  if (plan.visualizationType === "scatter_plot") return "one point per trial";
  if (plan.visualizationType === "network_graph") return "edge weight = shared trials";
  if (plan.groupBy && ["phase", "country", "condition", "intervention_type"].includes(plan.groupBy))
    return "trial appearances (a trial may span multiple categories)";
  return "trials";
}

function sortFor(plan: QueryPlan): string {
  if (plan.visualizationType === "time_series") return "year ascending";
  if (plan.visualizationType === "bar_chart") {
    const ranked = plan.sort !== undefined || plan.topN !== undefined;
    if (plan.groupBy === "phase" && !ranked) return "phase order";
    const dir = plan.sort === "asc" ? "ascending" : "descending";
    const base = `trial_count ${dir}`;
    return plan.topN ? `${base}, top ${plan.topN}` : base;
  }
  if (plan.groupBy === "phase") return "phase order";
  return "n/a";
}

export type { Encoding };
