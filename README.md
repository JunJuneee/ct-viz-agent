# ClinicalTrials.gov Query → Visualization Agent (Backend)

An AI-enabled backend that turns a **natural-language question about clinical trials**
into a **structured visualization specification** backed by live
[ClinicalTrials.gov Data API v2](https://clinicaltrials.gov/data-api/api) data.

A frontend can render the output without guessing: every response contains a
`visualization` (type, title, encoding, data) and a `meta` block (filters,
interpretation, traceability). As a bonus, **every visualized datum carries deep
citations** (NCT id + exact excerpt + deep link) back to the source records.

---

## 1. Quick start

```bash
# 1. install
npm install            # or: yarn install (needs Node 18.19+ / 20.6+)

# 2. configure (optional — see note below)
cp .env.example .env
#   set OPENAI_API_KEY=sk-...   (enables LLM interpretation)

# 3. run the server
npm start              # tsx src/index.ts  → http://localhost:3000
#   or: npm run dev        # watch mode
#   or: npm run build && npm run serve   # compiled JS

# 4. try it (plain request/response)
curl -s http://localhost:3000/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"How are melanoma trials distributed across phases?","condition":"melanoma"}' | jq

# 4b. or stream it (SSE): interpretation + live fetch progress + result
curl -sN "http://localhost:3000/query/stream?query=How%20are%20melanoma%20trials%20distributed%20across%20phases%3F&condition=melanoma"

# 5. demo UI (uses SSE — shows the agent's interpretation & fetch progress live)
open http://localhost:3000/demo

# 6. generate example outputs (also a live smoke test)
npm run examples           # writes examples/outputs/*.json

# 7. unit tests (deterministic core — no network/key needed)
npm test

# 8. or run in Docker
docker build -t ct-viz-agent .
docker run -p 3000:3000 -e OPENAI_API_KEY=sk-... ct-viz-agent
```

> **No API key?** The service still runs. It falls back to a deterministic
> keyword parser (`interpreter: "fallback-rules"` in the response). This keeps the
> reviewer able to run everything end-to-end with zero configuration; supply a key
> for the full natural-language coverage.

Requirements: Node 18.19+ (uses the built-in global `fetch`; on the 20.x line use 20.6+ — the OpenTelemetry deps require `^18.19.0 || >=20.6.0`).

> 📐 **Design decision log**: the points considered while building this, and the
> reasoning/tradeoffs behind each choice (e.g. why OpenAI Agents SDK was not used)
> are collected in [`DESIGN_DECISIONS.md`](DESIGN_DECISIONS.md). Per-module details
> live in each folder's `README.md` (`src/`, `src/agent/`, etc.); the architecture
> visual is in [`docs/architecture.html`](docs/architecture.html).

---

## 2. Architecture

The pipeline cleanly separates **interpretation** (the only place an LLM is used)
from **data + math** (fully deterministic, derived from real API records):

```
NL query
   │
   ▼
[interpret]  LLM (OpenAI, JSON-schema structured output) → QueryPlan
   │         └─ fallback: deterministic keyword parser
   ▼
[finalizePlan]  validate plan, merge caller-supplied fields (caller wins),
   │            enforce per-viz-type constraints, decide status
   │            (ok | needs_clarification | unsupported → no chart, return early)
   ▼
[buildQueryParams]  QueryPlan.filters → ClinicalTrials.gov v2 params
   │                (query.cond/intr/spons/locn, Essie filter.advanced, status)
   ▼
[fetchStudies]  paginate ALL matches (no truncation by default), retry/backoff, totalCount
   │
   ▼
[normalize]  raw record → flat NormalizedStudy
   │
   ▼
[aggregate]  count / time-series / histogram / scatter / network
   │         (+ attach deep citations to every datum)
   ▼
[assemble]  VisualizationSpec + ResponseMeta
   │
   ▼
AgentResponse  (JSON)
```

### Key design decision: the LLM never produces data

The model only ever emits a **`QueryPlan`** (which filters, which grouping, which
chart type). **Every number in the response is computed from real
ClinicalTrials.gov records** — the LLM cannot fabricate trial counts, NCT ids, or
results. This is the central anti-hallucination guard (see §6).

### Directory map

| Path | Responsibility |
|---|---|
| `src/agent/interpret.ts` | LLM call (OpenAI structured output) + fallback selection |
| `src/agent/interpretation.ts` | `QueryPlan` Zod + JSON schema (the model's contract) |
| `src/agent/fallback.ts` | deterministic keyword interpreter (no LLM) |
| `src/agent/planner.ts` | validation, caller-override merge, viz-type constraints |
| `src/agent/queryBuilder.ts` | `QueryPlan` → ClinicalTrials.gov v2 query params |
| `src/clinicaltrials/client.ts` | HTTP client: pagination, retry/backoff, `totalCount` |
| `src/clinicaltrials/normalize.ts` | raw API record → `NormalizedStudy` |
| `src/aggregate/*` | dimensions, aggregators, network builder, citations |
| `src/pipeline.ts` | orchestration (incl. multi-query comparison path) |
| `src/server.ts` | Express app, validation, error mapping |
| `demo/index.html` | optional zero-build frontend renderer |

---

## 3. Request schema (input)

> 📄 A machine-readable **OpenAPI 3.1 spec** for all endpoints lives in
> [`openapi.yaml`](openapi.yaml) — import it into Swagger UI / Postman, or generate a
> typed client. The tables below are the human-readable version.

`POST /query`, `Content-Type: application/json`.

| Field | Type | Req | Notes |
|---|---|---|---|
| `query` | string | **yes** | Natural-language question (1–2000 chars). |
| `drug_name` | string | no | Drug/intervention. Overrides inference. |
| `condition` | string | no | Disease/condition. Overrides inference. |
| `sponsor` | string | no | Sponsor/organization. |
| `country` | string | no | Country/location. |
| `trial_phase` | enum or enum[] | no | One/many of `EARLY_PHASE1,PHASE1,PHASE2,PHASE3,PHASE4,NA`. |
| `status` | string[] | no | Overall statuses, e.g. `["RECRUITING","COMPLETED"]`. |
| `study_type` | string | no | `INTERVENTIONAL` \| `OBSERVATIONAL` \| `EXPANDED_ACCESS`. |
| `start_year` | int | no | Inclusive lower bound on study start year. |
| `end_year` | int | no | Inclusive upper bound on study start year. |
| `visualization_type` | enum | no | Force a chart type (`bar_chart`, `grouped_bar_chart`, `time_series`, `scatter_plot`, `histogram`, `network_graph`). |

**Validation:** enforced by Zod (`src/schemas/request.ts`); unknown fields are
rejected (`.strict()`). Invalid requests return `400` with per-field details.
**Caller-supplied structured fields always override the LLM's inference** — explicit
intent wins.

Example:
```json
{ "query": "How has the number of trials for this drug changed over time?",
  "drug_name": "Pembrolizumab" }
```

---

## 4. Response schema (output)

```jsonc
{
  // null when meta.status !== "ok" (question out of scope / too vague — see meta.notes)
  "visualization": {
    "type": "bar_chart | grouped_bar_chart | time_series | scatter_plot | histogram | network_graph",
    "title": "string",
    "encoding": {                 // maps fields → visual channels
      "x": { "field": "category", "type": "ordinal", "label": "Phase" },
      "y": { "field": "trial_count", "type": "quantitative", "label": "Trial Count" }
      // network_graph uses "nodes"/"edges" channels instead of x/y
    },
    "data": [                     // present for chart types
      { "category": "Phase 3", "trial_count": 41,
        "citations": [ { "nct_id": "NCT01234567",
                         "excerpt": "Phase 3 — \"...\"",
                         "url": "https://clinicaltrials.gov/study/NCT01234567" } ] }
    ],
    "nodes": [ /* network_graph only: {id,label,group,weight} */ ],
    "edges": [ /* network_graph only: {source,target,weight,citations} */ ]
  },
  "meta": {
    "source": "clinicaltrials.gov",
    "apiVersion": "v2",
    "filters": { "...": "filters actually applied" },
    "totalMatchingTrials": 2884,  // API-reported total
    "analyzedTrials": 2884,       // records fetched & aggregated (all, by default)
    "truncated": false,           // false by default (full fetch); true only if a MAX_STUDIES cap was hit
    "groupBy": "phase",
    "units": "trials",            // or "trial appearances ...", "edge weight = shared trials"
    "sort": "phase order",
    "notes": "interpretation/assumptions surfaced to the client",
    "confidence": 0.9,
    "status": "ok",               // ok | needs_clarification | unsupported
    "interpreter": "llm",         // or "fallback-rules"
    "apiRequests": ["https://clinicaltrials.gov/api/v2/studies?..."],  // traceability
    "warnings": ["..."]
  },
  "references": [                  // deduped source cards for every cited trial
    { "nct_id": "NCT02068196", "title": "...", "officialTitle": "...",
      "sponsor": "Oslo University Hospital", "investigator": "Tormod Kyrre Guren, MD",
      "startDate": "2023-03-24", "url": "https://clinicaltrials.gov/study/NCT02068196" }
  ],
  "trace": {                      // verification: what the agent inferred + raw API I/O
    "queryPlan": { "...": "the validated QueryPlan" },
    "interpreter": "llm",
    "apiRequests": ["https://..."],
    "apiTotalCount": 2884,
    "apiResponseSample": [ /* first raw API records */ ]
  }
}
```

### When no chart is produced (`status` != `ok`)

The agent first decides whether the question is answerable from trial-registry data:

| `status` | meaning | response |
|---|---|---|
| `ok` | answerable | `visualization` populated |
| `needs_clarification` | on-topic but too vague (e.g. "show me trials" — no filter) | `visualization: null`, `meta.notes` asks for specifics |
| `unsupported` | out of scope (e.g. patient counts, drug prices, medical advice) | `visualization: null`, `meta.notes` explains why |

This prevents forcing a misleading chart, and a deterministic guard also blocks
zero-filter queries that would otherwise scan the entire registry.

### Per-type data shapes

| `type` | data shape | encoding channels |
|---|---|---|
| `bar_chart` | `{category, trial_count, citations}` | x=category, y=trial_count |
| `grouped_bar_chart` | `{group, series, trial_count, citations}` | x=group, y=trial_count, series |
| `time_series` | `{year, trial_count, citations}` (gap-filled) | x=year, y=trial_count |
| `histogram` | `{bucket, bucket_start, bucket_end, trial_count, citations}` | x=bucket, y=trial_count |
| `scatter_plot` | `{x, y, nct_id, label, citations}` | x, y |
| `network_graph` | `nodes:{id,label,group,weight}`, `edges:{source,target,weight,citations}` | nodes, edges |

---

## 5. Query & visualization coverage

A **single coherent approach** (plan → filter → aggregate) covers many query
families without one-off hacks:

| Question family | Example | Output |
|---|---|---|
| Time trends | "trials for *X* per year since 2015" | `time_series` |
| Distributions | "how are *X* trials distributed across phases" | `bar_chart` (by phase) |
| Distributions (numeric) | "distribution of enrollment sizes" | `histogram` |
| Categorical breakdowns | "most common intervention types / sponsors / statuses" | `bar_chart` |
| Comparisons | "compare phases for Drug A vs Drug B" | `grouped_bar_chart` (one API query per entity) |
| Geographic | "which countries have the most recruiting trials for *X*" | `bar_chart` (by country) |
| Relationships | "network of sponsors ↔ drugs", "drug ↔ drug co-occurrence" | `network_graph` |
| Correlation | "enrollment vs start year" | `scatter_plot` |

Grouping dimensions supported: `phase, year, country, sponsor, sponsor_class,
intervention_type, condition, status, study_type`. Network entities: `sponsor,
drug, condition` (bipartite or co-occurrence).

---

## 6. AI / agent design — avoiding hallucination

1. **The LLM cannot produce data.** It only emits a `QueryPlan`. All counts come
   from real records, so the model can never invent a trial count or NCT id.
2. **Structured outputs + schema validation.** The plan is generated via OpenAI's
   JSON-schema mode and then re-validated with Zod. Controlled vocabularies
   (enums) mean the model can't introduce unsupported fields or chart types.
3. **Constraint layer (`planner.ts`).** Plans are repaired/validated: a
   `grouped_bar_chart` without ≥2 comparison values is downgraded; year ranges are
   sanity-swapped; unknown phases are dropped; missing scatter/network/histogram
   parameters get safe defaults — each recorded in `meta.warnings`.
4. **Exact counts, no silent sampling.** By default the service paginates through
   ALL matching trials, so counts are exact (`meta.truncated=false`). If an optional
   `MAX_STUDIES` cap is set and exceeded, that is flagged with `meta.truncated=true`
   and a warning — never silently capped.
5. **Caller overrides win.** Explicit structured fields beat inference.
6. **Full traceability.** `meta.apiRequests` lists the exact API URLs; every datum
   carries citations to source records.

---

## 7. Validation / how correctness was checked

- **Live API contract checks** while building: field paths, Essie `filter.advanced`
  expressions (phase/date/study-type), and `filter.overallStatus` were each
  verified against the live endpoint.
- **End-to-end smoke tests** via `npm run examples` (6 queries covering every viz
  type) — outputs committed under `examples/outputs/`.
- **Type safety**: `npm run typecheck` (strict TypeScript).
- **Spot-checking counts** against the ClinicalTrials.gov website for sample
  queries, and confirming citations resolve to real study pages.

---

## 8. Observability & evaluation

Every `POST /query` can be traced and scored live. Three layers, each optional and
independently toggled — the service runs fully without any of them:

- **Langfuse** — LLM trace + token/cost + online-eval **scores**.
- **OpenTelemetry** — request/infra trace (HTTP, outbound fetch, pipeline stages).
- **LLM-as-judge** — a stronger model samples traffic and scores whether the
  visualization actually answers the question.

> **First time? You can skip this entire section.** `npm install && npm start`
> already runs end-to-end. The only thing worth adding for real use is
> `OPENAI_API_KEY` (without it, the deterministic fallback parser is used).
> Langfuse, OpenTelemetry and the LLM-as-judge are **all opt-in** — each stays off
> until you set its env var(s), so there are no surprise dependencies or costs.

### Quick start (local Langfuse)

```bash
npm run langfuse:up          # bundled server -> http://localhost:3001
# sign up, create a project, copy the API keys, then in .env:
#   LANGFUSE_PUBLIC_KEY=pk-lf-...
#   LANGFUSE_SECRET_KEY=sk-lf-...
#   LANGFUSE_BASEURL=http://localhost:3001
npm start                # fire a /query -> see it in the Langfuse "Traces" tab
npm run langfuse:down        # stop (data kept in volumes)
```

**No keys = dry-run:** nothing is sent; the eval scores that *would* be recorded are
logged to the console, so everything still runs end-to-end with zero config.

### What gets recorded

- **Deterministic scores** (no LLM, computed from the pipeline's own output):
  `used_fallback`, `empty_result`, `truncated`, `warning_count`, `plan_confidence`.
- **LLM-as-judge scores** (sampled): `judge_appropriate`, `judge_confidence`
  (+ the judge's reasoning in the score comment).
- **Token/cost**: the `interpret` LLM call is captured automatically (`observeOpenAI`).

### OpenTelemetry (optional)

```bash
npm run otel:up              # bundled Jaeger -> http://localhost:16686
# .env:  OTEL_ENABLED=true   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### Why three separate layers?

Deterministic scores are free and exact; the LLM-judge is the only one needing a
model, so it runs **async + sampled** and never blocks or breaks a request. OTel is
the vendor-neutral infra trace; Langfuse is the LLM-specific store (prompt, cost,
eval). Splitting them keeps each doing what it does best — full rationale in the docs:

- [`docs/observability.md`](docs/observability.md) — how to wire & run
- [`docs/otel-vs-langfuse.md`](docs/otel-vs-langfuse.md) — why OTel ≠ Langfuse
- [`docs/llm-as-judge.md`](docs/llm-as-judge.md) — the judge: fields, prompt, design

---

## 9. Configuration

| Env var | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | — | Enables LLM interpretation (else fallback parser). |
| `OPENAI_MODEL` | `gpt-4o-mini` | Must support JSON-schema structured outputs. |
| `PORT` | `3000` | HTTP port. |
| `MAX_STUDIES` | `0` (unlimited) | Optional cap on records fetched per request. `0` = fetch ALL matches (no truncation, exact counts); `N>0` bounds latency/cost. |
| `MAX_CITATIONS_PER_DATUM` | `3` | Citations attached to each datum. |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | Enable Langfuse tracing + online-eval scores. Both unset → dry-run (scores logged to console). |
| `LANGFUSE_BASEURL` | Langfuse Cloud | Self-host URL, e.g. `http://localhost:3001` (`LANGFUSE_BASE_URL` also accepted). |
| `OTEL_ENABLED` | `false` | App-level OpenTelemetry tracing. No OTLP endpoint → spans printed to console. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP target, e.g. `http://localhost:4318` (bundled Jaeger). |
| `JUDGE_SAMPLE_RATE` | `0` (off) | Fraction of traffic checked by the LLM-as-judge. `>0` opts in; `1` = every request. |
| `JUDGE_MODEL` | `gpt-4.1` | Judge model (stronger than the interpret model). |

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/query` | Plain request → full `AgentResponse` JSON. |
| `GET` | `/query/stream?query=…` | **SSE** stream: `status` → `interpretation` (LLM plan + notes) → `fetch_progress` (live pagination) → `result` → `done`. |
| `GET` | `/health` | Liveness + active interpreter. |

All three are formally described in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1).

---

## 10. Limitations & what I'd improve with more time

- **Large result sets are slow.** By default the service fetches ALL matching
  trials (exact counts, no sampling — `meta.truncated` is `false`). For very broad
  queries (e.g. unfiltered, 100k+ trials) this means many sequential page requests.
  *Next:* parallelize pagination, or use per-bucket `countTotal` queries to get exact
  totals cheaply and fetch records only for citations. A `MAX_STUDIES` cap is
  available to bound this in constrained environments.
- **Entity normalization.** Sponsor/drug strings are used as-is; "Merck" vs
  "Merck Sharp & Dohme" are distinct nodes. *Next:* add synonym/alias resolution.
- **No persistent cache.** Each request hits the API live. *Next:* add a short-TTL
  cache keyed by query params.
- **LLM grounding of entity names.** The model may pass a drug name the API spells
  differently. *Next:* a validation round-trip that confirms a filter yields
  results and suggests corrections.
- **Tests.** Covered by an end-to-end example runner and live contract checks; unit
  tests for aggregators/planner would harden regressions.

---

## 11. Integrity note (tools used)

- **Language/stack:** TypeScript + Express, Zod for validation, OpenAI SDK.
- **AI tools used:** the interpretation step uses the OpenAI API at runtime; the
  code was written with AI assistance and reviewed/adapted by hand.
- **Designed deliberately (not generated wholesale):** the plan/data separation,
  the `QueryPlan` contract + constraint layer, the aggregation + citation model,
  and the ClinicalTrials.gov query mapping (verified against the live API).
- **Validated:** live API contract checks, end-to-end example runs, strict
  typechecking, and manual spot-checks of counts/citations.
