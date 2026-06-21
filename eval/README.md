# Prompt evaluation (promptfoo)

Regression/quality eval for the agent's **interpret** step — the LLM call that
turns a natural-language clinical-trial question into a structured `QueryPlan`
(`src/agent/interpret.ts`).

> 📋 For the defects surfaced by the eval and the fixes applied, see [FINDINGS.md](./FINDINGS.md)
> (a record of the 19/23 → 23/23 improvement process).

## Why this design

The custom provider (`provider.cjs`) loads the **real** `interpretQuery` via `tsx`,
so the eval exercises the production system prompt, JSON schema, and Zod
validation directly. There is **one source of truth** — editing the prompt in
`src/agent/interpret.ts` automatically changes what the eval measures, with no
copy to drift out of sync.

If the LLM call fails, `interpretQuery` silently falls back to the deterministic
keyword parser. The provider detects that (`interpreter !== 'llm'`) and returns an
error so a misconfigured key or API outage **fails the eval loudly** instead of
quietly grading the wrong code path.

## Prerequisites

- **Node.js ≥ 20.20.0 (or ≥ 22.22.0)** — promptfoo refuses to start on older
  runtimes. The app itself runs on Node 19, so you may need a newer Node *just to
  run the eval* (e.g. `brew install node@22` and run with that on PATH, or use
  nvm/fnm). This does not change the app's runtime.
- `OPENAI_API_KEY` in `ct-viz-agent/.env` (already used by the app).
- `promptfoo` installed as a dev dependency (`npm install -D promptfoo`).
- Model: whatever `OPENAI_MODEL` is set to (default `gpt-4o-mini`).

> **Native fetch:** `provider.cjs` loads `openai/shims/web` before the OpenAI SDK
> so the SDK uses the runtime's native `fetch`. On Node ≥ 20 the SDK's bundled
> node-fetch path can fail with `FetchError: … Premature close` against the OpenAI
> API on some networks; native fetch is unaffected. Leave that require in place.

## Run

From the project root (`ct-viz-agent/`):

```bash
npm run eval          # run the suite, print a pass/fail table
npm run eval:view     # open the local results web UI
```

Or directly:

```bash
npx promptfoo eval -c eval/promptfooconfig.yaml
npx promptfoo view -y
```

## What it covers

`eval/dataset/tests.yaml` — 23 cases asserting the prompt's documented rules:

| Area | Examples |
|------|----------|
| Chart-type selection | bar / grouped_bar / time_series / histogram / scatter / network |
| Ranking rules | `top 5` → `sort=desc,topN=5`; "most" → `topN=10`; phase never sorted |
| Scope gating | patient counts / prices / medical advice → `unsupported`; vague → `needs_clarification` |
| Title honesty | "most COVID patients" reframed to **trials**; title must not say "patients" |
| Filter extraction | condition, sponsor, phase (`PHASE3`), status (`RECRUITING`), `startYearMin` |
| Caller-hint override | structured `condition` hint anchors a vague query |

Each assertion reads the returned `QueryPlan` JSON (`output`) and checks a single
field, so a failure points at exactly which rule regressed.

## Adding a test case

Append to `eval/dataset/tests.yaml`:

```yaml
- description: "short label of the behavior under test"
  vars:
    query: "the natural-language question"
    # optional caller hints: condition, sponsor, country, drug_name,
    # study_type, visualization_type, start_year, end_year, trial_phase, status
  assert:
    - type: javascript
      value: JSON.parse(output).visualizationType === 'bar_chart'
```

`output` is the `QueryPlan` JSON string — `JSON.parse(output)` then assert on a
field. Use `type: llm-rubric` (graded by `gpt-4o-mini`) for fuzzy checks like
title wording.

**Single-line vs multi-line assertions.** A single-line `value:` is treated as an
expression (implicit return). A multi-line `value: |` block is a function body and
**must `return`** — otherwise it evaluates to `undefined` and promptfoo reports
"Custom function must return a boolean…". Guard against missing fields too:

```yaml
    - type: javascript
      value: |
        const c = JSON.parse(output).comparison;       # may be undefined
        return !!c && (c.values || []).length >= 2;     # explicit return + guard
```

## Tuning

- **Different model:** set `OPENAI_MODEL` in `.env` and re-run to compare models
  on the same dataset.
- **A/B a prompt change:** edit `SYSTEM_PROMPT` in `src/agent/interpret.ts`, run
  `npm run eval` before/after, diff the pass rate.
