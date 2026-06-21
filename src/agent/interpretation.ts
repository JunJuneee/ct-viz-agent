import { z } from "zod";
import {
  COMPARISON_DIMENSIONS,
  GROUP_BY_DIMENSIONS,
  NETWORK_ENTITIES,
  NUMERIC_FIELDS,
  PLAN_STATUSES,
  SORT_DIRECTIONS,
  TRIAL_PHASES,
  VISUALIZATION_TYPES,
} from "../types";

/**
 * Zod schema for the QueryPlan the LLM must produce. We validate the model's
 * output against this before trusting it — a core anti-hallucination guard.
 * The same schema is converted to JSON Schema for OpenAI structured outputs.
 */
export const PlanFiltersSchema = z
  .object({
    condition: z.string().optional(),
    intervention: z.string().optional(),
    sponsor: z.string().optional(),
    location: z.string().optional(),
    term: z.string().optional(),
    phase: z.array(z.enum(TRIAL_PHASES)).optional(),
    status: z.array(z.string()).optional(),
    studyType: z.string().optional(),
    startYearMin: z.number().int().optional(),
    startYearMax: z.number().int().optional(),
  })
  .strip();

const QueryPlanObject = z
  .object({
    status: z.enum(PLAN_STATUSES).default("ok"),
    visualizationType: z.enum(VISUALIZATION_TYPES).optional(),
    filters: PlanFiltersSchema.default({}),
    groupBy: z.enum(GROUP_BY_DIMENSIONS).optional(),
    scatter: z
      .object({ x: z.enum(NUMERIC_FIELDS), y: z.enum(NUMERIC_FIELDS) })
      .optional(),
    histogram: z
      .object({ field: z.enum(NUMERIC_FIELDS), bucketSize: z.number().positive().optional() })
      .optional(),
    comparison: z
      .object({
        dimension: z.enum(COMPARISON_DIMENSIONS),
        values: z.array(z.string()).min(2),
      })
      .optional(),
    network: z
      .object({ source: z.enum(NETWORK_ENTITIES), target: z.enum(NETWORK_ENTITIES) })
      .optional(),
    sort: z.enum(SORT_DIRECTIONS).optional(),
    topN: z.number().int().positive().max(100).optional(),
    title: z.string().default("Clinical Trials Visualization"),
    notes: z.string().optional(),
    confidence: z.number().min(0).max(1).default(0.5),
  })
  .strip();

/**
 * Strip empty-string / null values before validation. Models (esp. with
 * non-strict JSON schema) often emit "" for an optional enum they don't use —
 * e.g. visualizationType="" when status="unsupported". Without this, Zod would
 * reject "" as an invalid enum and we'd wrongly fall back to the keyword parser.
 */
const stripEmpty = (val: unknown): unknown => {
  if (Array.isArray(val)) return val.map(stripEmpty);
  if (val && typeof val === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v === "" || v === null || v === undefined) continue; // drop blanks at every level
      const cleaned = stripEmpty(v);
      // Drop a sub-object that is empty after cleaning (e.g. an unused scatter:{x:""}
      // collapses to {} and is removed) so a blank/placeholder sub-object the model
      // emitted for a chart type it isn't using can't fail strict enum validation and
      // silently force the deterministic fallback parser.
      if (
        cleaned &&
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        Object.keys(cleaned as Record<string, unknown>).length === 0
      )
        continue;
      o[k] = cleaned;
    }
    return o;
  }
  return val;
};

/**
 * Each visualizationType owns exactly one optional sub-object. Models sometimes
 * also populate a sub-object for a chart type they did NOT choose (e.g. a scatter
 * plan that also carries network:{source:"enrollment"…}). Those stray sub-objects
 * hold values that are invalid for their own enum and would fail strict validation,
 * silently forcing the deterministic fallback. Drop every sub-object that does not
 * belong to the chosen visualizationType (and all of them when none is chosen).
 */
const SUBOBJECT_FOR_VIZ: Record<string, string> = {
  scatter_plot: "scatter",
  histogram: "histogram",
  grouped_bar_chart: "comparison",
  network_graph: "network",
};
const ALL_SUBOBJECTS = ["scatter", "histogram", "comparison", "network"] as const;

const pruneSubObjects = (val: unknown): unknown => {
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const o = { ...(val as Record<string, unknown>) };
  const viz = typeof o.visualizationType === "string" ? o.visualizationType : undefined;
  const keep = viz ? SUBOBJECT_FOR_VIZ[viz] : undefined;
  for (const k of ALL_SUBOBJECTS) if (k !== keep) delete o[k];
  return o;
};

export const QueryPlanSchema = z.preprocess(
  (val) => pruneSubObjects(stripEmpty(val)),
  QueryPlanObject,
);

export type ParsedPlan = z.infer<typeof QueryPlanSchema>;

/**
 * JSON Schema handed to OpenAI's structured-output mode. Mirrors the Zod schema.
 * Kept hand-written (rather than auto-derived) so the description prompts steer
 * the model's field choices precisely.
 */
export const OPENAI_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: [...PLAN_STATUSES],
      description:
        "ok = answerable, produce a chart; needs_clarification = on-topic but too vague to plan a query; unsupported = out of scope (cannot be answered from ClinicalTrials.gov trial registry data, e.g. patient counts, drug prices, medical advice). When not ok, leave visualizationType empty and explain why in notes.",
    },
    visualizationType: {
      type: "string",
      enum: [...VISUALIZATION_TYPES],
      description:
        "bar_chart for single-dimension counts; grouped_bar_chart when comparing 2+ entities; time_series for trends over years; histogram for numeric distributions (e.g. enrollment); scatter_plot to relate two numeric fields; network_graph for relationships between entities (sponsor/drug/condition).",
    },
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        condition: { type: "string", description: "disease/condition name" },
        intervention: { type: "string", description: "drug or intervention name" },
        sponsor: { type: "string" },
        location: { type: "string", description: "country or location" },
        term: { type: "string", description: "free-text search terms" },
        phase: { type: "array", items: { type: "string", enum: [...TRIAL_PHASES] } },
        status: { type: "array", items: { type: "string" }, description: "e.g. RECRUITING, COMPLETED" },
        studyType: { type: "string", description: "INTERVENTIONAL | OBSERVATIONAL | EXPANDED_ACCESS" },
        startYearMin: { type: "integer" },
        startYearMax: { type: "integer" },
      },
    },
    groupBy: {
      type: "string",
      enum: [...GROUP_BY_DIMENSIONS],
      description: "categorical dimension to count by; use 'year' for time_series",
    },
    scatter: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "string", enum: [...NUMERIC_FIELDS] },
        y: { type: "string", enum: [...NUMERIC_FIELDS] },
      },
      required: ["x", "y"],
    },
    histogram: {
      type: "object",
      additionalProperties: false,
      properties: {
        field: { type: "string", enum: [...NUMERIC_FIELDS] },
        bucketSize: { type: "number" },
      },
      required: ["field"],
    },
    comparison: {
      type: "object",
      additionalProperties: false,
      properties: {
        dimension: { type: "string", enum: [...COMPARISON_DIMENSIONS] },
        values: { type: "array", items: { type: "string" }, minItems: 2 },
      },
      required: ["dimension", "values"],
    },
    network: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", enum: [...NETWORK_ENTITIES] },
        target: { type: "string", enum: [...NETWORK_ENTITIES] },
      },
      required: ["source", "target"],
    },
    sort: {
      type: "string",
      enum: [...SORT_DIRECTIONS],
      description:
        "ranking direction for categorical bar charts — 'desc' for most/top/highest, 'asc' for fewest/least/lowest. Omit for time_series/scatter/network.",
    },
    topN: {
      type: "integer",
      description:
        "cutoff for ranked bar charts, e.g. 'top 5' → 5. If a ranking is implied but no number given, use 10.",
    },
    title: { type: "string" },
    notes: { type: "string", description: "assumptions or interpretation notes" },
    confidence: { type: "number" },
  },
  required: ["status", "filters", "title", "confidence"],
} as const;
