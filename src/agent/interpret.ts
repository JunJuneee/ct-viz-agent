import OpenAI from "openai";
import { observeOpenAI } from "langfuse";
import { config, llmEnabled } from "../config";
import type { Trace } from "../lib/langfuse";
import { RequestInput } from "../schemas/request";
import {
  OPENAI_PLAN_JSON_SCHEMA,
  ParsedPlan,
  QueryPlanSchema,
} from "./interpretation";
import { fallbackInterpret } from "./fallback";

export interface InterpretResult {
  plan: ParsedPlan;
  interpreter: "llm" | "fallback-rules";
  warnings: string[];
}

const SYSTEM_PROMPT = `You are a query-planning component for a clinical-trials data agent.
Your ONLY job is to translate a natural-language question into a structured QueryPlan
that downstream deterministic code will execute against the ClinicalTrials.gov API.

Hard rules:
- NEVER invent data, counts, NCT ids, or results. You only describe HOW to query and visualize.
- Emit ONLY the sub-object that matches visualizationType (scatter→scatter_plot, histogram→histogram,
  comparison→grouped_bar_chart, network→network_graph). OMIT every other sub-object entirely — never
  output one empty or with blank/placeholder fields.
- When status is "unsupported" or "needs_clarification": emit only status, title, notes, confidence;
  do NOT emit visualizationType or any sub-object.

Scope — decide if a visualization is even possible (set "status"):
- status="ok": the question is about clinical trials and can be answered from the
  ClinicalTrials.gov registry → choose exactly one visualizationType.
- status="unsupported": out of scope — the registry cannot answer it (e.g. number of
  PATIENTS/cases by country, drug prices, efficacy/medical advice, anything not about
  trial records). Leave visualizationType empty; explain why in notes.
- status="needs_clarification": on-topic but too vague to plan a query (e.g. "show me
  trials", "tell me about cancer"). Leave visualizationType empty; in notes, say what
  detail is needed (a condition, drug, dimension, or time range).
- Only when status="ok":
- Put concrete entities into filters (condition, intervention/drug, sponsor, location, years).
- For "compare A vs B" questions, set visualizationType=grouped_bar_chart and fill comparison.values=[A,B].
- For "over time / per year / since YEAR" questions, set visualizationType=time_series and groupBy=year.
- For co-occurrence / "which X go with which Y" between ENTITIES (sponsor, drug, condition), set
  visualizationType=network_graph and fill network.source/target — network nodes are ENTITIES ONLY,
  never numeric fields.
- For the relationship / correlation between TWO NUMERIC fields (enrollment, start_year), set
  visualizationType=scatter_plot and fill scatter.x/scatter.y. "Relationship between enrollment and
  start year" is a scatter_plot, NOT a network.
- For numeric distributions (e.g. enrollment size), use histogram.
- For counts grouped by a category (phase, country, sponsor, status, intervention_type, study_type, condition), use bar_chart with groupBy set.

Ranking (for bar_chart only):
- For a NON-phase grouping, a ranking word REQUIRES that you set BOTH sort AND topN:
  "most / top / highest / largest" → sort="desc"; "fewest / least / lowest / smallest" → sort="asc".
  A "Top …" title with no sort set is WRONG.
  e.g. "which countries have the most COVID trials" → groupBy="country", sort="desc", topN=10.
- topN = the requested cutoff ("top 5" → topN=5). If a ranking is implied but no number is given, use topN=10.
- groupBy="phase" is the EXCEPTION: phases are always shown in chronological order, so NEVER set sort
  or topN for it — even when the question says "most / fewest"
  (e.g. "which phase has the most trials" → groupBy="phase", NO sort, NO topN).
- Do NOT set sort/topN for neutral "distribution / breakdown / how are X distributed" questions —
  leave them unset so natural category order is used.
- NEVER set sort/topN for time_series, scatter_plot, or network_graph.

Title:
- The title MUST reflect the metric actually measured, which is the number of clinical TRIALS.
- Do NOT use terms the data cannot measure, such as "patients", "participants", "people", or
  "cases". The data counts trials, not patients.
- A question that asks for a COUNT of patients/people/cases (not trials) is OUT OF SCOPE:
  set status="unsupported" and explain in notes — do NOT silently reinterpret it as a trial count.
  e.g. "how many COVID patients by country" → status="unsupported".

- Keep confidence honest (lower it when the question is ambiguous) and explain assumptions in notes.`;

/**
 * Interpret the user query into a validated QueryPlan. Uses OpenAI structured
 * outputs when a key is configured; otherwise (or on failure) falls back to the
 * deterministic keyword parser. The result is always Zod-validated.
 */
export async function interpretQuery(
  input: RequestInput,
  trace?: Trace,
): Promise<InterpretResult> {
  const warnings: string[] = [];

  if (llmEnabled()) {
    try {
      const plan = await callOpenAI(input, trace);
      return { plan, interpreter: "llm", warnings };
    } catch (err) {
      warnings.push(
        `LLM interpretation failed (${String(err)}); used deterministic fallback parser.`,
      );
    }
  } else {
    warnings.push("No OPENAI_API_KEY configured; using deterministic fallback parser.");
  }

  const plan = fallbackInterpret(input.query);
  return { plan, interpreter: "fallback-rules", warnings };
}

async function callOpenAI(input: RequestInput, trace?: Trace): Promise<ParsedPlan> {
  const base = new OpenAI({ apiKey: config.openAiApiKey });
  // When a Langfuse trace is present, wrap the client so this generation's
  // prompt/completion, latency, token usage AND cost are captured automatically.
  const client = trace
    ? observeOpenAI(base, { parent: trace, generationName: "interpret" })
    : base;

  // Pass any caller-supplied structured hints so the model anchors on them.
  const hints = structuredHints(input);
  const userContent = hints
    ? `Question: ${input.query}\n\nCaller-supplied hints (treat as authoritative):\n${hints}`
    : `Question: ${input.query}`;

  const completion = await client.chat.completions.create({
    model: config.openAiModel,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "query_plan",
        strict: false,
        schema: OPENAI_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("empty completion");

  const parsed = QueryPlanSchema.parse(JSON.parse(raw));
  return parsed;
}

function structuredHints(input: RequestInput): string {
  const lines: string[] = [];
  if (input.drug_name) lines.push(`- intervention/drug = ${input.drug_name}`);
  if (input.condition) lines.push(`- condition = ${input.condition}`);
  if (input.sponsor) lines.push(`- sponsor = ${input.sponsor}`);
  if (input.country) lines.push(`- location/country = ${input.country}`);
  if (input.trial_phase) lines.push(`- phase = ${JSON.stringify(input.trial_phase)}`);
  if (input.status) lines.push(`- status = ${JSON.stringify(input.status)}`);
  if (input.study_type) lines.push(`- studyType = ${input.study_type}`);
  if (input.start_year) lines.push(`- startYearMin = ${input.start_year}`);
  if (input.end_year) lines.push(`- startYearMax = ${input.end_year}`);
  if (input.visualization_type)
    lines.push(`- visualizationType MUST be = ${input.visualization_type}`);
  return lines.join("\n");
}
