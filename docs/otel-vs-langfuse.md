# Why OpenTelemetry and Langfuse are kept separate

This project **deliberately splits observability across two tools**.

- **Langfuse** — the LLM-semantics layer
- **OpenTelemetry (OTel)** — the request/infra-trace layer

This doc explains why they aren't merged into one, and what each is responsible for.
For wiring/run instructions, see [`observability.md`](observability.md).

---

## 1. Background — this agent has two kinds of things to observe

The pipeline is `NL question → (interpret) LLM → QueryPlan → ClinicalTrials.gov fetch →
aggregate → response`. The LLM produces **only the `QueryPlan`**, and every number is
computed deterministically from real records. So "what needs to be observed" naturally
splits in two.

| Concern | Example questions | Nature |
|---|---|---|
| **LLM quality/cost** | Was the interpretation right? Did it fall back? Tokens/cost? Prompt/response? | domain (LLM) semantics |
| **Request/infra** | Where is it slow? Did an external API fail? What's the call structure? | distributed tracing |

These two have **different data models, lifecycles, and audiences.** Forcing them into
one tool would leave one side underserved.

---

## 2. The core reasons for splitting

### (a) The data models differ
- **Langfuse**: a `trace → observation(generation) → score` model. A generation carries the
  **full** prompt/response, model name, tokens, and **pricing-table-based cost ($)** as
  first-class fields. You attach online-eval metrics (fallback rate, empty rate, confidence)
  as scores and view them in time-series dashboards.
- **OTel**: a `span` tree model (parent-child). It carries standard semantic-convention
  attributes (http.\*, gen_ai.\*, latency = span duration, error status). **Bodies/content
  are intentionally excluded** by the standard (PII, size, performance).

The "full prompt + cost + eval scores" that LLM analysis needs don't fit naturally into the
OTel span model, and the end-to-end call tree isn't expressible in the Langfuse model.

### (b) Langfuse v3 is not OTel-based
The v3 SDK uses its own batch transport, so OTel setup is **unnecessary** (it works with
just keys). Conversely, you can't do whole-app tracing with Langfuse alone, without OTel.
The two mechanisms are simply different. (v4 is OTel-based, but this app effectively has a
single LLM call site, so it picks v3's simplicity — see
[`observability.md`](observability.md).)

### (c) Standard vs specialized tool — we want both
- OTel is a **vendor-neutral standard**. The same instrumentation can ship to Jaeger,
  Grafana, Datadog, etc. For infra layers (HTTP, outbound fetch, DB), OTel is by far the
  strongest.
- Langfuse is **LLM-specific**. Prompt version management, cost conversion,
  LLM-judge/online eval, and turning production traces into datasets are its core LLM
  workflows.

Replacing one with the other loses either standardization (OTel) or LLM specialization
(Langfuse).

### (d) Operational independence
Each is enabled/disabled separately. Without keys/flags they **disable harmlessly**.
- Langfuse: no keys → **dry-run** (sends nothing, logs eval scores to the console)
- OTel: no `OTEL_ENABLED` → **fully off** (zero overhead); no endpoint → console output

The app runs end-to-end even with no server up (a reviewer can run it with zero config).

---

## 3. Division of labor (based on real measurements)

The following was verified for an actual `/query` in Jaeger/Langfuse.

| What you want to see | Owner | Evidence (measured) |
|---|---|---|
| per-stage latency (interpret/execute_plan/LLM/fetch) | **OTel** | span duration: the LLM's 1211ms is most of the total 1903ms |
| call structure (parent-child tree) | **OTel** | `POST /query → interpret → chat gpt-4o-mini`, `execute_plan → GET ×N` |
| inbound/outbound HTTP metadata | **OTel** | `http.method/target/status`, full `url.full` of the ctgov call |
| token **count** (raw) | OTel **and** Langfuse | OTel: `gen_ai.usage.input_tokens=1408 / output_tokens=34` |
| token **cost ($)** | **Langfuse** | OTel doesn't convert cost → Langfuse computes it from a price table |
| **full** prompt/response | **Langfuse** | OTel spans have no text (metadata only) |
| HTTP request/response **bodies** | (neither collects) | excluded by semconv. Add via a hook if needed (with masking) |
| online-eval metrics (fallback rate, empty rate, confidence) | **Langfuse** | 5 `trace.score(...)` |
| errors/exceptions | **OTel** (+Langfuse) | `withSpan` records span status=ERROR + exception |

> The single overlapping point is **token count**. OTel captures counts via
> `gen_ai.usage.*` but **does not convert cost.** When you need cost, full prompts, or
> eval, look at Langfuse. This small overlap is not a problem — each tool just shows tokens
> in its own context.

---

## 4. One-line summary

> **OTel = "how the request flowed through the system" (latency · structure · HTTP · errors).
> Langfuse = "what the LLM did" (prompt · cost · eval).**
> They are complementary rather than competing, and splitting them lets each do what it does best.

---

## 5. They *can* be merged — with a tradeoff

The Langfuse server also offers an OTLP ingest endpoint (`/api/public/otel`), so you can
send OTel spans to Langfuse and **consolidate to one backend** (see "Optional: send OTel
spans to Langfuse" in [`observability.md`](observability.md)). However, the v3-SDK traces
and the OTLP spans remain **separate trace trees** within the same project (they are not
merged into one tree). So the default is to **keep them separate** (OTel→Jaeger, Langfuse
for LLM only).
