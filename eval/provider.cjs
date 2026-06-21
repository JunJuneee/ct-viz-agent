/**
 * Custom promptfoo provider — evaluates the REAL interpret prompt.
 *
 * It registers tsx's CommonJS loader so we can `require()` the TypeScript source
 * directly, then calls `interpretQuery` — the exact LLM step the production agent
 * uses (system prompt + JSON-schema structured output + Zod validation). This
 * keeps the eval honest: there is ONE source of truth (src/agent/interpret.ts).
 * Edit the prompt there and the eval follows automatically — no copy to drift.
 *
 * If the LLM call fails for any reason, interpretQuery silently falls back to the
 * deterministic keyword parser. We detect that and return an `error` so the eval
 * fails loudly instead of grading the wrong code path.
 */

const path = require("path");

const ROOT = path.join(__dirname, "..");

// 0) Force the OpenAI SDK to use the runtime's NATIVE fetch (undici) instead of
//    its bundled node-fetch shim. On Node >= 20 (which promptfoo requires) the
//    node-fetch path can fail with "FetchError: ... Premature close" against the
//    OpenAI API on some networks, while native fetch works. This must run BEFORE
//    'openai' is imported (transitively, via interpret.ts below).
require(path.join(ROOT, "node_modules", "openai", "shims", "web.js"));

// 1) Register tsx so require() can load .ts files from ../src.
require(path.join(ROOT, "node_modules", "tsx", "dist", "cjs", "index.cjs"));

// 2) Load env (OPENAI_API_KEY, OPENAI_MODEL, …) from the project's .env BEFORE
//    importing config.ts, which reads process.env at module-eval time.
require(path.join(ROOT, "node_modules", "dotenv")).config({
  path: path.join(ROOT, ".env"),
});

// 3) Import the real interpreter (type-only langfuse import is erased by tsx, so
//    no Langfuse client is constructed here).
const { interpretQuery } = require(path.join(ROOT, "src", "agent", "interpret.ts"));

// Optional structured caller-hint fields the agent accepts (see schemas/request.ts).
const STRING_HINTS = [
  "drug_name",
  "condition",
  "sponsor",
  "country",
  "study_type",
  "visualization_type",
];

class InterpretProvider {
  constructor(options = {}) {
    this.providerId = options.id || "ct-interpret";
    this.config = options.config || {};
  }

  id() {
    return this.providerId;
  }

  /**
   * @param {string} prompt   rendered prompt (we use vars.query instead; this is a fallback)
   * @param {{vars?: Record<string, unknown>}} context
   */
  async callApi(prompt, context = {}) {
    const vars = (context && context.vars) || {};

    // Build the RequestInput exactly as an API caller would. `query` is required;
    // the rest are optional hints the prompt is told to treat as authoritative.
    const input = {
      query: vars.query != null ? String(vars.query) : String(prompt),
    };
    for (const k of STRING_HINTS) {
      if (vars[k] != null && vars[k] !== "") input[k] = String(vars[k]);
    }
    if (vars.start_year != null) input.start_year = Number(vars.start_year);
    if (vars.end_year != null) input.end_year = Number(vars.end_year);
    if (vars.trial_phase != null) input.trial_phase = vars.trial_phase;
    if (vars.status != null)
      input.status = Array.isArray(vars.status) ? vars.status : [vars.status];

    // Retry on transient transport hiccups (e.g. undici "Premature close" under
    // concurrency). interpretQuery swallows the error and falls back to the rules
    // parser, so we detect that (interpreter !== 'llm') and retry the whole call.
    let lastWarnings = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await interpretQuery(input);
        if (res.interpreter === "llm") {
          // Output is the validated QueryPlan as JSON. Assertions JSON.parse(output).
          return { output: JSON.stringify(res.plan) };
        }
        lastWarnings = res.warnings;
      } catch (err) {
        lastWarnings = [String((err && err.stack) || err)];
      }
    }
    return {
      error:
        "interpret fell back to the deterministic rules parser after 3 attempts (LLM unavailable or failed): " +
        lastWarnings.join("; "),
    };
  }
}

module.exports = InterpretProvider;
