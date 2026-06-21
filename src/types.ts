/**
 * Shared domain types for the ClinicalTrials.gov visualization agent.
 *
 * The pipeline is: NL query --(interpret)--> QueryPlan --(fetch)--> NormalizedStudy[]
 *   --(aggregate)--> VizDatum[] --(assemble)--> AgentResponse
 *
 * The LLM only ever produces a QueryPlan. Every number in the final response is
 * derived deterministically from real API records, never from the model.
 */

// ---------------------------------------------------------------------------
// Controlled vocabularies (kept small & explicit so the LLM cannot invent fields)
// ---------------------------------------------------------------------------

export const VISUALIZATION_TYPES = [
  "bar_chart",
  "grouped_bar_chart",
  "time_series",
  "scatter_plot",
  "histogram",
  "network_graph",
] as const;
export type VisualizationType = (typeof VISUALIZATION_TYPES)[number];

export const GROUP_BY_DIMENSIONS = [
  "phase",
  "year",
  "country",
  "sponsor",
  "sponsor_class",
  "intervention_type",
  "condition",
  "status",
  "study_type",
] as const;
export type GroupByDimension = (typeof GROUP_BY_DIMENSIONS)[number];

export const NUMERIC_FIELDS = ["enrollment", "start_year"] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];

export const NETWORK_ENTITIES = ["sponsor", "drug", "condition"] as const;
export type NetworkEntity = (typeof NETWORK_ENTITIES)[number];

export const COMPARISON_DIMENSIONS = ["intervention", "condition", "sponsor"] as const;
export type ComparisonDimension = (typeof COMPARISON_DIMENSIONS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * Whether the question can actually be answered with a visualization.
 *   ok                 → produce a chart
 *   needs_clarification→ on-topic but too vague to plan a query
 *   unsupported        → out of scope (not answerable from trial data)
 */
export const PLAN_STATUSES = ["ok", "needs_clarification", "unsupported"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const TRIAL_PHASES = [
  "EARLY_PHASE1",
  "PHASE1",
  "PHASE2",
  "PHASE3",
  "PHASE4",
  "NA",
] as const;

// ---------------------------------------------------------------------------
// QueryPlan — the structured interpretation produced by the agent's LLM step
// ---------------------------------------------------------------------------

export interface PlanFilters {
  /** Disease / condition (maps to query.cond). */
  condition?: string;
  /** Drug / intervention (maps to query.intr). */
  intervention?: string;
  /** Sponsor / organization (maps to query.spons). */
  sponsor?: string;
  /** Country or location (maps to query.locn). */
  location?: string;
  /** Free-text terms (maps to query.term). */
  term?: string;
  /** Restrict to specific phases. */
  phase?: (typeof TRIAL_PHASES)[number][];
  /** Restrict to overall recruitment statuses (e.g. RECRUITING). */
  status?: string[];
  /** INTERVENTIONAL | OBSERVATIONAL | EXPANDED_ACCESS. */
  studyType?: string;
  /** Inclusive lower bound on study start year. */
  startYearMin?: number;
  /** Inclusive upper bound on study start year. */
  startYearMax?: number;
}

export interface ComparisonSpec {
  dimension: ComparisonDimension;
  /** The two-or-more entities being compared, e.g. ["Drug A", "Drug B"]. */
  values: string[];
}

export interface NetworkSpec {
  source: NetworkEntity;
  target: NetworkEntity;
}

export interface QueryPlan {
  /** Whether a visualization can/should be produced for this question. */
  status: PlanStatus;
  /** Visualization the answer should be rendered as (when status === "ok"). */
  visualizationType: VisualizationType;
  /** Structured filters extracted from the question. */
  filters: PlanFilters;
  /** Categorical dimension to group/count by (bar/grouped/time charts). */
  groupBy?: GroupByDimension;
  /** Ranking direction for categorical bar charts: "desc" = most, "asc" = fewest. */
  sort?: SortDirection;
  /** Cutoff for ranked bar charts (e.g. "top 5" → 5). */
  topN?: number;
  /** For scatter plots: the two numeric axes. */
  scatter?: { x: NumericField; y: NumericField };
  /** For histograms: the numeric field whose distribution is bucketed. */
  histogram?: { field: NumericField; bucketSize?: number };
  /** For grouped bar / multi-series comparisons. */
  comparison?: ComparisonSpec;
  /** For network graphs: which entity types form the two node sets. */
  network?: NetworkSpec;
  /** Human-readable chart title. */
  title: string;
  /** The agent's notes about assumptions / interpretation. */
  notes?: string;
  /** Self-reported interpretation confidence 0..1. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// NormalizedStudy — a flat projection of a ClinicalTrials.gov record
// ---------------------------------------------------------------------------

export interface NormalizedStudy {
  nctId: string;
  briefTitle: string;
  officialTitle: string | null;
  investigator: string | null;
  phases: string[];
  studyType: string | null;
  overallStatus: string | null;
  startDate: string | null;
  startYear: number | null;
  leadSponsor: string | null;
  sponsorClass: string | null;
  conditions: string[];
  interventions: { type: string; name: string }[];
  countries: string[];
  enrollment: number | null;
}

// ---------------------------------------------------------------------------
// Visualization output
// ---------------------------------------------------------------------------

export interface Citation {
  nct_id: string;
  /** Exact text excerpt from the API record supporting the datum. */
  excerpt: string;
  /** Direct link to the study record. */
  url: string;
}

/** One renderable data point. Shape varies slightly by chart type but is flat. */
export interface VizDatum {
  [key: string]: string | number | null | Citation[] | undefined;
  citations?: Citation[];
}

export interface NetworkNode {
  id: string;
  label: string;
  /** Entity kind, e.g. "sponsor" | "drug". */
  group: string;
  /** Number of trials the node participates in. */
  weight: number;
}

export interface NetworkEdge {
  source: string;
  target: string;
  /** Number of trials connecting the two nodes. */
  weight: number;
  citations?: Citation[];
}

export interface Encoding {
  [channel: string]: { field: string; type?: string; label?: string } | undefined;
}

export interface VisualizationSpec {
  type: VisualizationType;
  title: string;
  encoding: Encoding;
  /** Tabular data for chart types; omitted for network graphs. */
  data?: VizDatum[];
  /** Node/edge data for network graphs. */
  nodes?: NetworkNode[];
  edges?: NetworkEdge[];
}

export interface ResponseMeta {
  source: "clinicaltrials.gov";
  apiVersion: "v2";
  /** Filters that were actually applied to the API query. */
  filters: PlanFilters;
  /** Total matching trials reported by the API (before fetch cap). */
  totalMatchingTrials: number;
  /** How many records were fetched & aggregated. */
  analyzedTrials: number;
  /** True when totalMatchingTrials exceeded the fetch cap (counts are a sample). */
  truncated: boolean;
  groupBy?: GroupByDimension;
  units?: string;
  sort?: string;
  /** Interpretation notes / assumptions surfaced to the client. */
  notes?: string;
  confidence: number;
  /** ok | needs_clarification | unsupported. */
  status: PlanStatus;
  /** How the query was interpreted: "llm" or "fallback-rules". */
  interpreter: "llm" | "fallback-rules";
  /** The exact ClinicalTrials.gov API request URLs used (traceability). */
  apiRequests: string[];
  warnings?: string[];
}

/**
 * Verification trace. Lets a client inspect (1) what the agent inferred and
 * (2) exactly what was asked of / returned by ClinicalTrials.gov — so every
 * number in the visualization can be traced back to its source.
 */
export interface ResponseTrace {
  /** #1 — the structured plan the agent inferred (LLM or fallback) before execution. */
  queryPlan: QueryPlan;
  /** Whether the plan came from the LLM or the deterministic fallback parser. */
  interpreter: "llm" | "fallback-rules";
  /** #2a — exact ClinicalTrials.gov API request URL(s) issued. */
  apiRequests: string[];
  /** #2b — total matching trials the API reported. */
  apiTotalCount: number;
  /** #2c — a small sample of RAW, unmodified API study records for spot-checking. */
  apiResponseSample: unknown[];
}

/**
 * A rich source card for a cited trial — everything a UI needs to render a
 * ClinicalTrials.gov reference (badge, titles, sponsor, NCT link, date, PI).
 */
export interface Reference {
  nct_id: string;
  title: string;
  officialTitle: string | null;
  sponsor: string | null;
  investigator: string | null;
  startDate: string | null;
  url: string;
}

export interface AgentResponse {
  /** null when status !== "ok" (no chart produced — see meta.status/notes). */
  visualization: VisualizationSpec | null;
  meta: ResponseMeta;
  /** Deduplicated source cards for every trial cited by the visualization. */
  references?: Reference[];
  /** Optional verification trace (LLM plan + raw API request/response). */
  trace?: ResponseTrace;
}
