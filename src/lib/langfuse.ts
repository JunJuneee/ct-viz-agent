import { Langfuse } from "langfuse";
import "../config"; // ensures dotenv.config() has run before we read env below
import type { AgentResponse } from "../types";

/**
 * Langfuse (v3) client for live observability + online evaluation.
 *
 * Three modes, decided purely by whether LANGFUSE_* keys are present:
 *   - enabled  : keys set  -> traces + token/cost + scores sent to Langfuse.
 *   - dry-run  : no keys    -> nothing is sent; the eval scores that WOULD be
 *                recorded are logged to the console instead, so you can develop
 *                and verify the instrumentation locally with no server.
 *
 *   LANGFUSE_PUBLIC_KEY   pk-lf-...
 *   LANGFUSE_SECRET_KEY   sk-lf-...
 *   LANGFUSE_BASEURL      http://localhost:3001  (self-host) | omit for cloud
 */
const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();

export const langfuseEnabled = !!publicKey && !!secretKey;
/** True when no keys are configured: we log locally instead of sending. */
export const langfuseDryRun = !langfuseEnabled;

export const langfuse = new Langfuse({
  publicKey,
  secretKey,
  // Accept both spellings (LANGFUSE_BASEURL is the SDK's canonical name; we also
  // honor LANGFUSE_BASE_URL for convenience). Omit -> Langfuse Cloud.
  baseUrl:
    process.env.LANGFUSE_BASEURL?.trim() ||
    process.env.LANGFUSE_BASE_URL?.trim() ||
    undefined,
  // `enabled: false` makes every call a no-op AND silences the missing-key
  // warning, so dry-run mode stays quiet except for our own console output.
  enabled: langfuseEnabled,
});

/** Convenience alias for the trace handle returned by `langfuse.trace(...)`. */
export type Trace = ReturnType<typeof langfuse.trace>;

/**
 * Deterministic online-eval metrics, computed from the pipeline's own output
 * (no LLM judge needed). Same set is sent as Langfuse scores when enabled, or
 * printed when in dry-run.
 */
export function evalScores(response: AgentResponse): Record<string, number> {
  const m = response.meta;
  return {
    used_fallback: m.interpreter === "fallback-rules" ? 1 : 0,
    empty_result: m.analyzedTrials === 0 ? 1 : 0,
    truncated: m.truncated ? 1 : 0,
    warning_count: m.warnings?.length ?? 0,
    plan_confidence: m.confidence,
  };
}

/**
 * Attach the eval metrics to the request's trace. With keys -> Langfuse scores
 * + trace output. Without keys (dry-run) -> a single console line so you can see
 * exactly what would have been recorded.
 */
export function recordEval(trace: Trace | undefined, response: AgentResponse): void {
  const scores = evalScores(response);

  if (trace) {
    trace.update({ output: response });
    for (const [name, value] of Object.entries(scores)) trace.score({ name, value });
    return;
  }

  if (langfuseDryRun) {
    console.log(
      `[langfuse:dry-run] trace="query" interpreter=${response.meta.interpreter} ` +
        `scores=${JSON.stringify(scores)}`,
    );
  }
}
