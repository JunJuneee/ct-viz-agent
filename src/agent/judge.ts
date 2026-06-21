import OpenAI from "openai";
import { observeOpenAI } from "langfuse";
import { z } from "zod";
import { config } from "../config";
import type { Trace } from "../lib/langfuse";
import type { RequestInput } from "../schemas/request";
import type { AgentResponse } from "../types";

/**
 * LLM-as-judge: an online quality check that runs AFTER the response is built.
 *
 * It does NOT touch the data path (the answer is already returned to the caller);
 * it samples a fraction of traffic, asks a *stronger* model whether the produced
 * visualization appropriately answers the question, and records the verdict as
 * Langfuse scores. Fire-and-forget — never blocks or fails the request.
 *
 * Output (forced via JSON schema):
 *   verdict     "appropriate" | "inappropriate"   — 적절 / 부적절
 *   confidence  "high" | "medium" | "low"          — the judge's own certainty
 *   reason      short justification                — WHY (for debugging the judge)
 */
const JUDGE_MODEL = process.env.JUDGE_MODEL?.trim() || "gpt-4.1";
// Opt-in: OFF by default (0). Set JUDGE_SAMPLE_RATE > 0 to enable, so a fresh
// setup with only an OPENAI_API_KEY never incurs surprise judge costs.
const JUDGE_SAMPLE_RATE = clamp01(Number(process.env.JUDGE_SAMPLE_RATE ?? "0"));

/** On when an API key exists and sampling is explicitly turned on. */
export const judgeEnabled = config.openAiApiKey.length > 0 && JUDGE_SAMPLE_RATE > 0;

const VerdictSchema = z.object({
  verdict: z.enum(["appropriate", "inappropriate"]),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().max(600),
});
type Verdict = z.infer<typeof VerdictSchema>;

/** LLM self-reported confidence is poorly calibrated — treat it as a triage
 * signal, not a probability. Mapped to a number purely for dashboard averages. */
const CONFIDENCE_VALUE: Record<Verdict["confidence"], number> = {
  high: 1,
  medium: 0.6,
  low: 0.3,
};

const JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "reason"],
  properties: {
    verdict: { type: "string", enum: ["appropriate", "inappropriate"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string", description: "1-2 sentences citing the specific issue." },
  },
} as const;

const SYSTEM_PROMPT = `You are a STRICT evaluator for a clinical-trials visualization agent.
The agent turns a natural-language question into a visualization SPEC (chart type,
grouping, filters, title) backed by ClinicalTrials.gov data. You judge ONLY whether
that spec appropriately answers the question — you do NOT re-fetch or recount data.

Mark "inappropriate" if any of these are wrong for the question:
- chart type (e.g. a ranking asked but no sort; a trend asked but not time_series)
- grouping dimension (e.g. "by phase" but grouped by country)
- filters (wrong/missing condition, drug, country, year, status)
- title claims something the data cannot measure (e.g. "patients" — it counts TRIALS)
- scope gating: status="unsupported"/"needs_clarification" used when the question
  WAS answerable, or status="ok" forced on a truly out-of-scope question.

Be skeptical. If you are not confident it is correct, choose "inappropriate" and "low".
Keep confidence honest: "high" only when the spec is clearly right or clearly wrong.`;

/**
 * Sample + judge. Safe to call without awaiting; swallows all errors.
 */
export async function maybeJudge(
  input: RequestInput,
  response: AgentResponse,
  trace?: Trace,
): Promise<void> {
  if (!judgeEnabled) return;
  // Sample a fraction of traffic. (App runtime — Math.random is available.)
  if (JUDGE_SAMPLE_RATE < 1 && Math.random() > JUDGE_SAMPLE_RATE) return;

  try {
    const verdict = await runJudge(input, response, trace);
    const comment = `${verdict.confidence}: ${verdict.reason}`;

    if (trace) {
      trace.score({
        name: "judge_appropriate",
        value: verdict.verdict === "appropriate" ? 1 : 0,
        comment,
      });
      trace.score({
        name: "judge_confidence",
        value: CONFIDENCE_VALUE[verdict.confidence],
        comment: verdict.confidence,
      });
    } else {
      // dry-run (no Langfuse keys): surface locally.
      console.log(`[judge] ${verdict.verdict} (${verdict.confidence}) — ${verdict.reason}`);
    }
  } catch (err) {
    console.error("[judge] failed (non-fatal):", String(err));
  }
}

async function runJudge(
  input: RequestInput,
  response: AgentResponse,
  trace?: Trace,
): Promise<Verdict> {
  const base = new OpenAI({ apiKey: config.openAiApiKey });
  // Wrap so the judge call ALSO shows up as a generation under the trace
  // (its own token/cost is tracked, separate from the interpret generation).
  const client = trace
    ? observeOpenAI(base, { parent: trace, generationName: "judge" })
    : base;

  const plan = response.trace?.queryPlan;
  const evidence = {
    question: input.query,
    caller_hints: callerHints(input),
    chosen: {
      status: response.meta.status,
      visualizationType: response.visualization?.type ?? null,
      title: response.visualization?.title ?? null,
      groupBy: response.meta.groupBy ?? null,
      sort: plan?.sort ?? null,
      topN: plan?.topN ?? null,
      filters: response.meta.filters,
      comparison: plan?.comparison ?? null,
      analyzedTrials: response.meta.analyzedTrials,
      notes: response.meta.notes ?? null,
    },
  };

  const completion = await client.chat.completions.create({
    model: JUDGE_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Judge whether this visualization spec appropriately answers the question.\n\n" +
          JSON.stringify(evidence, null, 2),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "judge_verdict",
        strict: true,
        schema: JUDGE_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("empty judge completion");
  return VerdictSchema.parse(JSON.parse(raw));
}

function callerHints(input: RequestInput): Record<string, unknown> {
  const h: Record<string, unknown> = {};
  for (const k of [
    "drug_name",
    "condition",
    "sponsor",
    "country",
    "trial_phase",
    "status",
    "study_type",
    "start_year",
    "end_year",
    "visualization_type",
  ] as const) {
    if (input[k] !== undefined) h[k] = input[k];
  }
  return h;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
