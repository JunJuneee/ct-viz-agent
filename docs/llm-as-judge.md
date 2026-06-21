# LLM-as-judge (online quality check)

An LLM-as-judge validates whether each produced visualization **actually answers
the user's question** — the one quality dimension the deterministic scores can't
measure. It runs as a separate, sampled, async layer and records its verdict as
Langfuse scores. Wiring/run steps: [`observability.md`](observability.md).

> For why the two observability tools (OTel vs Langfuse) are split, see
> [`otel-vs-langfuse.md`](otel-vs-langfuse.md). This doc additionally covers
> **why the judge is isolated into a separate layer**.

---

## 1. What it evaluates

The judge **does not regenerate data.** It only checks whether the already-produced
visualization *spec* is appropriate for the question (chart type · grouping · filters ·
title · scope gating). In other words, there is no room for the LLM to hallucinate
numbers — the project's core principle (the LLM never generates data) is applied to the
judge as well.

## 2. Output — 3 fields

Enforced via structured output (JSON schema, strict):

| Field | Values | Meaning / why |
|---|---|---|
| `verdict` | `appropriate` \| `inappropriate` | appropriate/inappropriate — the core verdict |
| `confidence` | `high` \| `medium` \| `low` | the judge's own confidence. **An enum, not a float (0–1)** — an LLM's self-reported confidence is poorly calibrated, so discrete levels are more stable and easier to threshold. |
| `reason` | 1–2 sentences | the rationale. **Without it you can't debug "why inappropriate"**, and writing the rationale before the conclusion also improves verdict accuracy. |

The first cut had just 2 fields (verdict + confidence), but `reason` was **added** for the
reasons above. Confidence is used as a **triage signal**, not a "ground truth" — `low`
routes to a human-review queue.

## 3. Langfuse score mapping

| score | value | note |
|---|---|---|
| `judge_appropriate` | 1 / 0 | `appropriate`=1. Mean = **appropriateness rate** |
| `judge_confidence` | high=1 / medium=0.6 / low=0.3 | numeric, for dashboard averaging |
| (comment) | `"<confidence>: <reason>"` | the rationale attached to the score comment |

The judge call itself is also recorded on the trace as a `judge` generation, so its
tokens/cost are tracked.

## 4. Prompt

**System** (grading criteria):
```
You are a STRICT evaluator for a clinical-trials visualization agent.
... You judge ONLY whether that spec appropriately answers the question —
you do NOT re-fetch or recount data.

Mark "inappropriate" if any of these are wrong:
- chart type · grouping dimension · filters · title (claiming something the data
  cannot measure) · scope gating (blocked an answerable question, or forced "ok"
  on an unanswerable one)

Be skeptical. If unsure, "inappropriate" + "low". Use "high" only when it's obvious.
```

**User** (the thing being judged = evidence JSON; the raw data is not provided):
```json
{
  "question": "<original question>",
  "caller_hints": { /* condition/drug/country etc. the user specified */ },
  "chosen": {
    "status": "ok|unsupported|needs_clarification",
    "visualizationType": "bar_chart", "title": "...",
    "groupBy": "phase", "sort": null, "topN": null,
    "filters": { "condition": "melanoma" },
    "comparison": null, "analyzedTrials": 200, "notes": "..."
  }
}
```
The full prompt lives in `SYSTEM_PROMPT` / `runJudge` in `src/agent/judge.ts`.

## 5. Operational design — why it's isolated "this way"

Why the judge is a **separate layer** rather than inlined into the main pipeline:

1. **Separated from the data path (async · non-blocking).** The judge runs in the
   background *after* the response is produced. It adds no LLM latency to the user
   response, and even if the judge fails the request never breaks (errors are swallowed).
   Quality measurement must not hold the feature hostage.
2. **Separated from deterministic eval.** Metrics like fallback rate, empty rate, and
   truncated are computed for free without an LLM (the 5 scores in
   [`observability.md`](observability.md)). The judge handles only "appropriateness,"
   which needs an LLM — **don't mix the expensive signal with the free ones.**
3. **Sampling (off by default).** One extra LLM call per request is cost/load.
   `JUDGE_SAMPLE_RATE` is **0 (off) by default** — it only runs when explicitly enabled.
   The recommended production value is **20%** (`0.2`); use `1` during development when you
   need full coverage. Being opt-in means the initial setter incurs no cost just by adding a key.
4. **A different (stronger) model than the one being judged.** If the same model grades its
   own output, they share the same blind spots. The judge uses **`gpt-4.1`**, stronger than
   interpret (gpt-4o-mini) (this key's project lacks gpt-4o access, so gpt-4.1 is used
   instead of gpt-4o).
5. **Skeptical default.** When uncertain, lean to `inappropriate`+`low` to reduce
   rubber-stamp (always-pass) bias.

## 6. Configuration

| Env | Default | Meaning |
|---|---|---|
| `JUDGE_SAMPLE_RATE` | `0` (off) | grading rate (opt-in). `0`=off (default), `1`=all, `0.2`=20% |
| `JUDGE_MODEL` | `gpt-4.1` | judge model (stronger than interpret) |
| `OPENAI_API_KEY` | — | without it, the judge is disabled |

If there is no key (Langfuse dry-run) or no trace, the judge result is printed to the
console as `[judge] ...`.

## 7. How to read it on the dashboard

In Langfuse Scores:
- **Appropriateness rate** = mean of `judge_appropriate` (a drop signals degrading
  interpretation quality)
- **Low-confidence rate** = the fraction with low `judge_confidence` → a "needs human
  review" funnel

These two are tracked on the same screen as the deterministic scores (fallback rate,
empty rate).
