# Prompt evaluation results & fix log

A record of evaluating the `interpret` prompt (natural-language question → `QueryPlan`)
with promptfoo, and fixing the surfaced defects in the prompt/schema code. For how to use
the eval harness, see [README.md](./README.md).

- Target: `SYSTEM_PROMPT` in `src/agent/interpret.ts` + the schema in `src/agent/interpretation.ts`
- Model: `gpt-4o-mini` (temperature 0, JSON-schema structured output)
- Dataset: `dataset/tests.yaml` (23 cases)

## Result progression

| Stage | Pass | Fail | Error | Note |
|------|------|------|------|------|
| Initial run | 14/23 (60.9%) | 7 | 2 | 5 of the 7 fails were **test-harness bugs** (below) |
| After harness-bug fix | 19/23 (82.6%) | 2 | 2 | the remaining 4 were **real prompt/schema defects** |
| After prompt+code fix | **23/23 (100%)** | 0 | 0 | stable across 2 consecutive runs, `tsc --noEmit` passes |

> **fail vs error** — *fail*: the model produced a plan but its content differed from
> expectations. *error*: the model couldn't produce a valid plan at all (Zod validation
> throws → rule-based fallback).

## Environment notes (watch out when reproducing)

1. **Node version** — promptfoo requires Node ≥20.20 (or ≥22.22), but this machine's
   default Node is 19. Run the eval on a separate Node ≥20.20 (`brew install node@22`, etc.).
   No effect on the app runtime (19).
2. **native fetch** — on Node ≥20, the OpenAI SDK's bundled node-fetch fails entirely on
   some networks with `FetchError: … Premature close`. Fixed by having `provider.cjs` load
   `openai/shims/web` first so the runtime's native fetch is used.

---

## Harness bugs (my test-code mistake — 5 cases)

In promptfoo's `javascript` assertion, **a multi-line `value: |` block is a function body**,
so without a `return` it returns `undefined` and raises "Custom function must return…". A
single-line one is an expression and is returned implicitly. Added `return` + null guards to
the 5 affected asserts. (Rule documented in the README's "Adding a test case".)

---

## 4 real findings + root cause + fix

### ① Ranking words ignored (sort/topN missing)

- **Question**: "Which countries have the most COVID-19 trials?"
- **Model output**: `groupBy=country`, title="Top Countries…" but `sort`/`topN` unset. It
  wrote "Top" in the title yet didn't actually sort.
- **Cause**: the prompt's ranking rule was weakly worded.
- **Fix (prompt)**: strengthened to "if a non-phase grouping has a ranking word, you MUST
  set `sort`+`topN`" and added an example. Split out into a separate bullet that
  `groupBy=phase` is always chronological so it is **never sorted** (see regression ②-bis below).

### ② Vague question → empty sub-object → Zod failure → silent fallback

- **Question**: "Show me trials" / "Tell me about cancer"
- **Model output**: while sending `needs_clarification`, it also emitted an unused empty
  sub-object like `scatter:{x:undefined}` → Zod required-enum validation throws → falls back
  to the rule parser. The user thinks the LLM worked, but it was actually the low-quality path.
- **Cause**: `stripEmpty` only removed top-level `""`/`null` and couldn't strip empty
  sub-objects.
- **Fix (code, robust defense)**: made `stripEmpty` **recursive** to remove empty values at
  every depth + drop sub-objects that became empty. Also added a prompt rule: "do not emit
  unused sub-objects."

### ②-bis (regression) ranking over-applied to phase

- Right after ①'s ranking strengthening, "Which phase has the most melanoma trials?" made the
  model attach `sort=desc, topN=10` to `groupBy=phase` (wrong, since phase is chronological).
- **Fix**: pulled the phase exception out of the parentheses into its own **emphasized
  bullet** ("for phase, never set sort/topN even for most/fewest"). Re-running normalized it.

### ③ A scatter question misclassified as network_graph

- **Question**: "Is there a relationship between enrollment size and start year…?"
- **Model raw output** (confirmed via debug):
  ```json
  {"visualizationType":"network_graph","network":{"source":"enrollment","target":"start_year"}, …}
  ```
  The word "relationship" sent it to network, and it **put numeric fields into network**.
  The network enum allows only sponsor/drug/condition → Zod throws → fallback.
- **Cause**: the scope section had **no scatter_plot guidance at all**, and the network rule
  captured "relationship" too broadly.
- **Fix (prompt)**: clearly distinguished "a relationship between two **numeric fields** =
  `scatter_plot`" from "**entity** (sponsor/drug/condition) relationships = `network_graph`
  (no numbers)".
- **Fix (code, extra defense)**: `pruneSubObjects` — removes sub-objects unrelated to the
  chosen visualizationType **before** validation. Even if the model fills the wrong slot, it
  no longer falls back.

### ④ Internal prompt contradiction — "patient count by country"

- **Question**: "Which countries have the most COVID-19 patients?"
- **Conflict**: the scope rule said "patient count = `unsupported`", while the Title rule said
  "reframe a patient question into trials and return `ok`" — contradictory instructions for
  the same situation. The model chose `unsupported`.
- **Decision**: settled on **rejecting with `unsupported`**.
- **Fix (prompt)**: removed the "reframe to ok" part of the Title rule, unifying on "a
  request for a **count** of patients/people/cases = `unsupported`". Also changed test #18's
  expected value to `unsupported`.

---

## Files changed

| File | Change |
|------|------|
| `src/agent/interpret.ts` | strengthen ranking rule · split out phase exception, distinguish scatter/network, patient-question = unsupported, forbid unused sub-objects |
| `src/agent/interpretation.ts` | make `stripEmpty` recursive, add `pruneSubObjects` |
| `eval/dataset/tests.yaml` | fix 5 harness bugs (`return`+guards), #18 expected = unsupported |
| `eval/provider.cjs` | native-fetch shim, transient retry |

## Reproduce

```bash
# on a Node ≥20.20 environment (the app runs on 19)
npm run eval          # 23/23 pass
npm run eval:view     # inspect per-case input/output in the web viewer
```
