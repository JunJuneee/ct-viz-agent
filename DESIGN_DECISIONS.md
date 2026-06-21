# Design Decisions & Tradeoffs

> This document collects, in one place, **the points considered while building this
> and the reasoning/tradeoffs behind each choice**.
> It maps to the evaluation criteria *System Design / AI·Agent Design* and the
> Integrity Note ("what was deliberately designed vs generated/adapted").

Each item is organized as **Decision / Consideration / Choice / Tradeoff (or alternative)**.

---

## 0. One-line philosophy

> **"The AI interprets (how to query and visualize). The code produces the data (the actual numbers)."**
> This single sentence is the root of nearly every decision below.

---

## 1. Why the OpenAI **Agents SDK** (autonomous-agent framework) was NOT used ★

- **Decision**: instead of `@openai/agents` (a tool-call-loop / handoff framework), use
  the plain `openai` SDK + a **fixed pipeline** (interpret → validate → fetch → aggregate → assemble).
- **Consideration**: since the assignment is named "Agent", an autonomous agent loop
  (the LLM calling API tools and reasoning on its own) seemed like a natural fit.
- **Why this choice**:
  1. **Hallucination control** — an autonomous loop lets the LLM drive data retrieval and
     interpretation directly, leaving room to fabricate numbers or call the wrong number of
     times. The fixed pipeline enforces "the LLM only plans, the code executes."
  2. **Predictability & debugging** — a deterministic flow makes it easy to trace what
     happened at which step, and it is reproducible.
  3. **Cost & latency** — exactly one LLM call per query (an autonomous loop makes many).
  4. **Portability** — `chat.completions` + JSON Schema is the most basic API, so swapping
     models/providers is easy.
- **Tradeoff**: for genuinely open-ended, multi-step reasoning (e.g. "go find more data if
  needed"), an autonomous agent is more flexible. This assignment is a well-defined
  "query → visualization" transform, so the control a fixed pipeline gives is more valuable.
- **Bottom line**: the LLM does the **agentic reasoning** (understanding intent, forming a
  plan), but the code holds the **authority to execute** that plan.

---

## 2. The LLM never produces data (interpretation / data separation) ★

- **Decision**: the LLM outputs only a `QueryPlan` (filters, grouping, chart type). Every
  number in the response (trial counts, NCT ids, aggregates) is computed by code from real
  API records.
- **Consideration**: asking the LLM to "also produce the chart data" would be convenient in
  one shot.
- **Why this choice**: doing so makes the model generate plausible-but-wrong numbers
  (hallucination). Accuracy is paramount for clinical data, so this is never acceptable.
- **Tradeoff**: having the LLM produce data too would reduce code, but it forfeits
  reliability → not an option.

---

## 3. Parameter extraction (①) and visualization-type choice (③) merged into **one LLM call**

- **Decision**: rather than two separate calls (① extract → ③ choose type), get the whole
  `QueryPlan` (filters + groupBy + visualizationType) in a single structured output.
- **Consideration**: conceptually "extraction" and "visualization-type choice" are distinct
  steps, so separating them looks cleaner.
- **Why this choice**: the two decisions are tightly coupled (knowing the intent fixes both
  filters and chart type). Splitting into two calls only **doubles latency/cost and adds a
  risk of inconsistency between the two responses**, with no benefit.
- **Tradeoff**: per-step observability (which step went wrong) is slightly lower, but
  `planner.ts` validates the received plan field by field, so there is no real loss.

---

## 4. Visualization-type choice is a **hybrid** (rules + LLM + code validation)

- **Decision**: the LLM proposes the visualization type (or `fallback.ts` rules when no key),
  and `planner.ts` (code) makes the final enum validation/correction.
- **Consideration**: the visualization type is fairly deterministic from intent ("over time"
  → time_series, etc.) → it could be pure rules. Is AI even needed?
- **Why this choice**: the option set is a closed 6-value enum, so the **risk is low**, and
  the LLM handles ambiguous queries more smoothly. So we let the LLM decide but keep a code
  safety net ("AI proposes, code confirms").
- **Tradeoff**: rules alone are 100% deterministic but weak on diverse phrasing. The hybrid
  is the balance point between coverage and control.

---

## 5. **Re-validate LLM output with Zod** (defense in depth)

- **Decision**: even though OpenAI is forced into a JSON Schema (`response_format: json_schema`),
  the returned JSON is validated again with `QueryPlanSchema.parse()` (Zod).
- **Consideration**: the schema is already enforced — is a second validation really needed?
- **Why this choice**: model output must be treated as untrusted input to be safe. This
  reliably blocks controlled-vocabulary (enum) violations and type mismatches at runtime.
- **Tradeoff**: slight redundancy, but the cost relative to the reliability gained is
  negligible.

---

## 6. A deterministic fallback parser that **works without a key**

- **Decision**: when `OPENAI_API_KEY` is missing or the LLM call fails, automatically switch
  to the keyword parser in `fallback.ts` (shown as `interpreter: "fallback-rules"` in the
  response).
- **Consideration**: since the assignment calls for an LLM (OpenAI), a fallback may seem
  unnecessary.
- **Why this choice**:
  1. **A reviewer can run it immediately without a key** and verify the whole pipeline
     (robustness).
  2. The service does not die even during an LLM outage (graceful degradation).
  3. The data/aggregation/citation paths are identical with or without the LLM, so testing
     is easy.
- **Tradeoff**: the rule parser has narrow natural-language coverage (so it reports a low
  `confidence` and recommends using structured fields). It is limited to being a backstop
  for the LLM path.

---

## 7. **Caller-supplied structured fields override LLM inference**

- **Decision**: if the request includes explicit fields like `drug_name`, `condition`, they
  override whatever the LLM inferred.
- **Consideration**: the LLM might be smarter — is it OK to prioritize human input?
- **Why this choice**: explicit intent is more reliable than a guess (the safe direction).
  When a frontend wants to pin a filter, it behaves deterministically.
- **Tradeoff**: if the user supplies a wrong field, it is used as-is — but that is the user's
  responsibility.

---

## 8. **Exact counts by default + honest limit reporting** (full fetch)

- **Decision**: the default is a **full fetch** (`MAX_STUDIES=0` = unlimited) — follow
  `nextPageToken` to the end and aggregate the entire match set, so counts are **exact** and
  `meta.truncated=false`. An optional cap (`MAX_STUDIES>0`) is the only case that samples,
  shown via `meta.truncated=true` + a warning. In addition, the **top-N category cap**
  (readability; counts stay exact) and the **excluded-record count** (missing fields) are
  always reported.
- **Consideration**: sampling is faster, but a "sample that looks like the whole population"
  is dangerous in a clinical context. Conversely, a full fetch is slow.
- **Why this choice**: accuracy/trust first → full fetch as the default. Limits (sampling /
  omissions) are never hidden.
- **Tradeoff**: very broad queries become slow → filterless queries are guarded with
  `needs_clarification` (see #16). A `MAX_STUDIES` cap can be set if needed.

---

## 9. Comparison (grouped bar) runs **a separate query per entity** then merges

- **Decision**: "A vs B" is not mixed into one query; a separate API query runs per entity,
  each is aggregated, then merged by `series` (`executeComparison` in `pipeline.ts`).
- **Consideration**: ORing both drugs into one query would reduce it to a single call.
- **Why this choice**: mixing with OR makes it impossible to separate the two groups' counts,
  which breaks the meaning of a comparison.
- **Tradeoff**: the number of API calls grows with the number of compared entities, but
  accurate group separation is essential.

---

## 10. Aggregation approach: **fetch records and aggregate in the app** vs per-bucket countTotal

- **Decision**: fetch (by default) all matching records and aggregate in the app.
- **Consideration**: firing a separate `countTotal` query per phase/year could obtain counts
  more cheaply.
- **Why this choice**: the bonus requirements — **deep citations** and **reference cards**
  (#17) — need real records. Record-based aggregation solves counts, citations, and
  references in one pass.
- **Tradeoff**: very large result sets have many pages and are slow. The README limitations
  note improvements: "per-bucket countTotal for counts + fetch only a few records for
  citations" or "parallelized pagination".

---

## 11. The network graph is **capped to the top edges/nodes**

- **Decision**: keep the top edges by weight (default 120) + a node-count limit, and mark
  `truncated` when cut. Node ids are namespaced as `group:name` (avoiding same-name
  collisions).
- **Consideration**: returning the entire graph loses no information.
- **Why this choice**: hundreds-to-thousands of nodes are unrenderable/meaningless on the
  frontend. To produce a "meaningful network", prioritize the strongest relationships.
- **Tradeoff**: weak relationships are omitted → noted as a limitation.

---

## 12. Controlled vocabularies (enums) + single-source types (`types.ts`)

- **Decision**: fix chart types, grouping dimensions, network entities, etc. as enums in
  `types.ts`, shared by the schema, aggregation, and response.
- **Consideration**: free-form strings would be more flexible.
- **Why this choice**: a closed vocabulary keeps the LLM from inventing arbitrary values,
  catches omissions at compile time, and makes the extension point clear ("just add to the
  enum here").
- **Tradeoff**: adding a new type requires editing several files together, but that is
  actually the safer extension path.

---

## 13. Language/stack: **TypeScript + Express**

- **Decision**: TS + Express, Zod (validation), OpenAI SDK.
- **Consideration**: Python (FastAPI) is also natural for an AI backend.
- **Why this choice**: static types express the schema and domain model robustly, and connect
  naturally to the optional frontend demo.
- **Tradeoff**: fewer LLM/data ecosystem libraries than Python, but enough for this
  assignment's scope.

---

## 14. Known limitations & what I'd do with more time

- **Broad-query latency** → the default full fetch is slow when results are large (many
  pages). Improve with per-bucket countTotal or parallelized pagination.
- **No entity normalization** ("Merck" vs "Merck Sharp & Dohme" are separate nodes) → add
  alias/synonym resolution.
- **No cache** → a short-TTL cache keyed by query params.
- **LLM entity grounding** → if an extracted drug name yields 0 results, a validation
  round-trip that proposes a correction via the API.
- **Tests** → unit tests (Vitest, 42 cases) cover the deterministic core
  (aggregators, planner status/ranking guards, queryBuilder Essie expressions, normalize,
  fallback, schema stripEmpty), plus an end-to-end example runner and live contract checks.
  Could add HTTP-level integration tests with a mocked CT.gov client.

---

## 15. AI tools used (Integrity)

- **Runtime**: the OpenAI API is used in the interpretation step (`chat.completions` + JSON
  Schema structured output).
- **Development**: code was written with AI assistance, then reviewed/edited by hand.
- **Deliberately designed parts**: interpretation/data separation, the `QueryPlan` contract
  + constraint layer, the aggregation/citation model, and the ClinicalTrials.gov query
  mapping (verified against the live API).
- **Validation methods**: live API contract checks (field paths, Essie filters), end-to-end
  example runs, strict typechecking, and manual spot-checks of counts/citations.

---

## 16. **"Decide whether a visualization is needed" (status gate)**

- **Decision**: the LLM first sets `status` (`ok` | `needs_clarification` | `unsupported`).
  When not ok, it produces no chart and returns `visualization: null` + guidance (notes). In
  addition, the planner **deterministically downgrades a zero-filter ok plan to
  `needs_clarification`** (preventing a whole-registry runaway).
- **Consideration**: always forcing a chart is simpler, but out-of-scope ("weather") or vague
  ("show me trials") questions then produce a wrong/huge chart.
- **Why this choice**: directly addresses step 3 of assignment 1) "identify if a
  visualization is needed", and prevents hallucination/misuse.
- **Tradeoff**: the LLM can occasionally miss the classification, so a code guard
  (filterless → clarify) is kept as a safety net.

---

## 17. **Beyond deep citations: reference cards**

- **Decision**: in addition to per-datum citations (nct_id + excerpt), the response includes
  **`references[]`** (rich cards for the cited trials: title, official title, sponsor,
  responsible investigator, start date, link). This required requesting the extra fields
  `officialTitle` and `responsibleParty.investigatorFullName`.
- **Consideration**: citations alone already satisfy traceability.
- **Why this choice**: the frontend can render "source cards" directly, improving UX and
  trust (a card UI is implemented in the demo).
- **Tradeoff**: slightly more fields/payload, but it strengthens the bonus (traceability).

---

## 18. **SSE streaming + demo interaction**

- **Decision**: in addition to `POST /query` (batch), provide `GET /query/stream` (SSE) —
  streaming the events `status → interpretation (LLM plan+notes) → fetch_progress (live
  pages) → result`. The demo shows interpretation/progress live via EventSource, and on
  `needs_clarification` it presents a **narrowing form** (condition/drug/country/sponsor/year)
  to re-request with added filters.
- **Consideration**: a plain request/response would be simpler to implement.
- **Why this choice**: a full fetch takes time, so showing progress/interpretation improves
  UX, and it lets the user immediately refine a vague question.
- **Tradeoff**: more endpoint/frontend complexity. The batch path is kept as-is to also
  support simple integration.

---

## 19. **Ranking (sort/topN)**

- **Decision**: handle "most/top N/fewest" on bar charts via `QueryPlan.sort` (desc/asc) +
  `topN`. Dimensions with an inherent order, like phase, get no ranking (kept chronological)
  — enforced both in the prompt and by a code guard.
- **Consideration**: should sorting come from LLM free text or fixed rules?
- **Why this choice**: the LLM proposes, the planner/aggregator validate and apply ("AI
  proposes, code confirms").
- **Tradeoff**: more rules, but queries like "fewest" and "top 5" are handled accurately.

---

## 20. **Observability + online evaluation (Langfuse / OpenTelemetry)**

- **Decision**: when keys are present, record a Langfuse trace per request (auto-capturing the
  interpretation LLM call's tokens/cost/latency) + deterministic quality scores (fallback
  rate, empty results, confidence, etc.). OTel spans are also optional. With no keys, it's a
  no-op.
- **Consideration**: operational features beyond the assignment's scope.
- **Why this choice**: demonstrates "evidence of testing/iteration" and real quality
  tracking. Everything is optional, so default behavior is unaffected.
- **Tradeoff**: added dependencies/code. See `docs/observability.md`,
  `docs/otel-vs-langfuse.md`, and `docs/llm-as-judge.md` for details.
