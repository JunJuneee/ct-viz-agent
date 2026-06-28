# `src/schemas` — Input schema module

Defines the Zod schema that validates the HTTP request body. It is the first line
of defense, blocking invalid input before it enters the pipeline.

## File layout

| File | Responsibility |
|---|---|
| `request.ts` | The Zod schema (`RequestSchema`) and type (`RequestInput`) for the `POST /query` request body |

## Request schema

| Field | Type | Required | Description |
|---|---|:--:|---|
| `query` | string (1–2000) | ✅ | Natural-language question |
| `drug_name` | string | | Drug/intervention (overrides inference) |
| `condition` | string | | Condition (overrides inference) |
| `sponsor` | string | | Sponsor/organization |
| `country` | string | | Country/location |
| `trial_phase` | enum \| enum[] | | `EARLY_PHASE1,PHASE1,PHASE2,PHASE3,PHASE4,NA` |
| `status` | string[] | | e.g. `["RECRUITING","COMPLETED"]` |
| `study_type` | string | | `INTERVENTIONAL` \| `OBSERVATIONAL` \| `EXPANDED_ACCESS` |
| `start_year` / `end_year` | int | | Start-year range |
| `visualization_type` | enum | | Force a specific chart type |

## Validation rules

- **`.strict()`** — rejects undefined fields (catches typos/misuse early).
- **Type & range constraints** — year 1900–2100, string length caps, phase/viz types validated as enums.
- On validation failure, `server.ts` catches the `ZodError` and responds with **`400` + per-field reasons**:
  ```json
  { "error": "invalid_request",
    "details": [{ "path": "query", "message": "Required" }] }
  ```

## Design points

- **Caller-wins principle** — the structured fields received here override LLM inference in
  `planner.ts`. Explicit intent always takes priority over inference.
- **Satisfies the clarification guard** — providing any structured filter (or `visualization_type`)
  makes the query specific enough to pass the planner's "no-filter → `needs_clarification`" guard and
  produce a chart directly.
- Single source of truth for types — `RequestInput = z.infer<typeof RequestSchema>` guarantees runtime
  validation and the compile-time type in one place.

## Rationale — why these choices

- **`.strict()` rejects unknown fields.** Default Zod silently ignores extras, so a typo
  like `drugName` would be dropped and silently mis-answered; strict mode turns that into a
  clear `400`, making the API contract explicit.
- **Caller fields override LLM inference.** Explicit intent is more trustworthy than a guess;
  this is the single safe direction and lets a frontend pin filters deterministically.
- **One schema as the source of truth (`z.infer`).** Runtime validation and the compile-time
  type come from the same definition, so they can never drift apart.

> Full reasoning + tradeoffs for every decision: [`../../DESIGN_DECISIONS.md`](../../DESIGN_DECISIONS.md).

## Related modules

- Consumers: `../server.ts` (validation), [`../agent`](../agent/README.md) (`interpret`/`planner` use the fields)
- Controlled-vocabulary source: `../types.ts` (`TRIAL_PHASES`, `VISUALIZATION_TYPES`)
