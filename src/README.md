# `src` — Source overview & core modules

The top-level source directory holding the backend's entry point, orchestration,
shared types, and configuration. See each subfolder's `README.md` for module details.

## Pipeline at a glance

```
NL query
  │  agent/interpret  ── (LLM structured output or fallback)
  ▼  agent/planner    ── validation/normalization + status gate
QueryPlan {status, ...}
  │  status ≠ ok (out of scope / vague) → early return with a guidance response, no chart
  │  agent/queryBuilder
  ▼  clinicaltrials/client → normalize   ── real data (full fetch by default)
NormalizedStudy[]
  │  aggregate/*  ── aggregation + citation
  ▼  pipeline     ── assemble VisualizationSpec + references[] + trace
AgentResponse (JSON)
```

## Core files (directly in this directory)

| File | Responsibility |
|---|---|
| `index.ts` | Bootstrap — creates the server, listens on `PORT`, prints startup logs |
| `server.ts` | Express app — `POST /query`, **`GET /query/stream` (SSE streaming)**, `/health`, `/demo`, Zod validation, centralized error mapping (`400`/`502`/`500`), CORS |
| `pipeline.ts` | **Orchestration** — interpret→plan→fetch→aggregate→assemble. Early return with no chart when `status≠ok`, multi-query comparison (grouped bar, `executeComparison`), per-chart encoding, assembly of `references[]` (`collectReferences`) and `trace`, SSE progress events (`emit`) |
| `config.ts` | Env loading (`dotenv`) + `llmEnabled()` (selects LLM/fallback by key presence), `maxStudies` (default 0 = unlimited) |
| `types.ts` | **Domain types & controlled vocabularies** — single source of truth for `VISUALIZATION_TYPES`, `GROUP_BY_DIMENSIONS`, `PLAN_STATUSES`, `SORT_DIRECTIONS`, `QueryPlan`, `NormalizedStudy`, `VisualizationSpec`, `Reference`, `AgentResponse`, etc. |

## Submodules

| Module | Role | Docs |
|---|---|---|
| `agent/` | Query interpretation & planning (the only place the LLM is involved) | [README](agent/README.md) |
| `clinicaltrials/` | API retrieval & normalization | [README](clinicaltrials/README.md) |
| `aggregate/` | Aggregation & evidence (citations) | [README](aggregate/README.md) |
| `schemas/` | Input validation | [README](schemas/README.md) |

## Key design principles

1. **Separation of interpretation (LLM) from data/computation (deterministic)** — the
   LLM only produces a `QueryPlan`; every number is computed from real data → blocks hallucination.
2. **Single source of truth for types** — the enums/interfaces in `types.ts` are shared by
   schemas, aggregation, and the response.
3. **Deciding whether a visualization is needed (`status`)** — only answerable questions become
   charts. Out of scope → `unsupported`; too vague (no filter) → `needs_clarification` (guidance
   instead of a chart). `visualization` is then `null`.
4. **Exact counts by default + honest limits** — full fetch by default (`truncated=false`);
   exceeding an optional cap, top-N category omission, and excluded counts are always surfaced via
   `meta.truncated`/`meta.warnings`.
5. **Full traceability** — `meta.apiRequests` (actual request URLs), per-datum citations,
   `references[]` (source cards), `trace` (plan + raw API response sample).

## Running

| Command | Description |
|---|---|
| `npm start` | Run the server with tsx |
| `npm run dev` | Watch mode |
| `npm run build && npm run serve` | Compile then run |
| `npm run typecheck` | Strict type check |
| `npm run examples` | Run the 9 examples (6 charts + ranking + unsupported + needs_clarification, a live smoke test) |
