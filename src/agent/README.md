# `src/agent` — Query interpretation & planning module

The module that turns a natural-language question into a **validated `QueryPlan`
(how to query and visualize)**. This is the **only place in the pipeline where the
LLM is involved**, and the core principle is:
> **The LLM only decides "how to query"; it never produces data (numbers, NCT ids).**

## File layout

| File | Responsibility |
|---|---|
| `interpretation.ts` | The `QueryPlan` **contract** — Zod schema + JSON Schema for OpenAI. Controlled vocabularies (enums) prevent the model from inventing arbitrary fields/chart types. Includes `status` (ok/needs_clarification/unsupported) and `sort`/`topN`. Empty strings/null are stripped before validation (`stripEmpty`) |
| `interpret.ts` | LLM call entry point. With a key, produces the plan via OpenAI structured output; on failure or with no key, automatically falls back |
| `fallback.ts` | **Deterministic keyword parser without the LLM**. Keeps the service running with zero config (includes "A vs B" comparison and "most/top/fewest" ranking pattern extraction) |
| `planner.ts` | Validation/normalization layer. Caller-field override + per-chart structural constraints + **`status` gate** (downgrades a no-filter ok plan to `needs_clarification` to prevent a full-scan runaway) + ranking (`sort`/`topN`) normalization |
| `queryBuilder.ts` | Converts `QueryPlan.filters` → ClinicalTrials.gov v2 query parameters |

## Data flow

```
query (string)
   │  interpret.ts ─ interpretQuery()
   ▼
ParsedPlan  ── (OpenAI structured output → Zod validation)  or  (fallback.ts keyword parser)
   │  planner.ts ─ finalizePlan()
   ▼
QueryPlan   ── caller-field merge + constraint fixups (+ warnings)
   │  queryBuilder.ts ─ buildQueryParams()
   ▼
CtgovQueryParams  → passed to the clinicaltrials module
```

## Design points (hallucination prevention)

1. **Forced structured output** — `interpret.ts` uses `response_format: { type: "json_schema" }`
   so the model only emits JSON matching `OPENAI_PLAN_JSON_SCHEMA`.
2. **Double validation** — the model response is re-validated with `QueryPlanSchema.parse()` (Zod).
3. **Constraint layer** — `planner.ts` repairs malformed plans (e.g. a `grouped_bar_chart` without
   enough comparison values is downgraded to `bar_chart`, reversed year ranges are fixed, unsupported
   phases are dropped) and records the reason in `warnings`.
4. **Visualization-need gate (`status`)** — never forces a chart onto an unanswerable question. Out of
   scope is `unsupported`; vague/no-filter is `needs_clarification`, with `visualization=null` + guidance (notes).
5. **Caller wins** — the request's structured fields (`drug_name`, `condition`…) always override LLM inference.
6. **Temperature 0** — keeps interpretation deterministic.

## How to extend

- **Add a new chart type**: add the enum to `VISUALIZATION_TYPES` in `types.ts` → update the
  `interpretation.ts` JSON Schema description → add structural constraints in `planner.ts`.
- **Add a new filter**: reflect it in `PlanFilters` in `types.ts`, the `interpretation.ts` schema,
  the `queryBuilder.ts` mapping, and the `planner.ts` merge logic.

## Related modules

- Next step: [`../clinicaltrials`](../clinicaltrials/README.md) (actual data retrieval)
- Full orchestration: `../pipeline.ts`
