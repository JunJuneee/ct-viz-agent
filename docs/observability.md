# Live observability & online evaluation (Langfuse)

> For **why these two tools (OTel/Langfuse) are kept separate**, see [`otel-vs-langfuse.md`](otel-vs-langfuse.md).
> This doc covers *how to enable and use them* (wiring and running).

Each `POST /query` is traced with [Langfuse](https://langfuse.com) (JS SDK v3):

- **One trace per request** (`name: "query"`), with the interpretation LLM call
  nested as a generation — so **token usage, cost and latency are captured
  automatically** (via `observeOpenAI`, no manual accounting).
- **Deterministic online-eval scores** attached to every trace (no LLM judge):
  `used_fallback`, `empty_result`, `truncated`, `warning_count`, `plan_confidence`.
  They roll up into Langfuse trend dashboards (fallback rate, empty-result rate…).

## Modes (decided by whether `LANGFUSE_*` keys are set)

| Keys | Behavior |
|---|---|
| set    | Traces + token/cost + scores are sent to Langfuse. |
| **unset** | **Dry-run**: nothing is sent; the eval scores that *would* be recorded are printed to the console (`[langfuse:dry-run] …`). The service runs end-to-end with zero config. |

## Local Langfuse server (bundled)

You have two ways to get a Langfuse instance + API keys. Either works the same
from the app's side — only the keys and `LANGFUSE_BASEURL` differ.

### Option A — Self-host locally (bundled, no external account)

A self-contained stack ships in `docker-compose.langfuse.yml` (Postgres +
ClickHouse + Redis + MinIO + web + worker, all pre-built images — no repo clone).

```bash
npm run langfuse:up          # start (UI: http://localhost:3001)
#   web is mapped to host :3001 so it never collides with the app on :3000
#   first boot pulls images + runs DB migrations — give it ~1 min, then refresh
```

1. **Open http://localhost:3001 → "Sign up".** This is *your own* local instance,
   so the email/password is just a local account — no email verification, nothing
   leaves your machine. The first user becomes the admin.
2. **Create an Organization, then a Project** (the onboarding wizard walks you
   through both).
3. **Project → Settings → API Keys → "+ Create new API key".** Copy both —
   the **secret key (`sk-lf-…`) is shown only once**:
   ```
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_BASEURL=http://localhost:3001
   ```
   Put them in `.env`.
4. `npm start`, fire a `/query`, then watch **Tracing → Traces**.

```bash
npm run langfuse:down        # stop (keeps data in named volumes)
npm run langfuse:logs        # tail the web container (handy if the UI won't load yet)
```

### Option B — Langfuse Cloud (no Docker)

Prefer not to run containers? Use the managed service (has a free tier):

1. Go to **https://cloud.langfuse.com** → sign up (Google / GitHub / email).
2. Create an **Organization → Project**, then **Settings → API Keys → Create**.
3. In `.env`, use the keys and set `LANGFUSE_BASEURL` to your **region**:
   ```
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_BASEURL=https://cloud.langfuse.com        # EU region
   # LANGFUSE_BASEURL=https://us.cloud.langfuse.com   # US region
   ```

### Official guides & links

| | |
|---|---|
| GitHub (source, issues) | https://github.com/langfuse/langfuse |
| Docs home | https://langfuse.com/docs |
| Self-hosting guide | https://langfuse.com/self-hosting |
| Langfuse Cloud (signup) | https://cloud.langfuse.com |
| JS/TS SDK reference | https://langfuse.com/docs/sdk/typescript |
| Evaluation / scores | https://langfuse.com/docs/evaluation |

---

# OpenTelemetry (app/infra tracing)

Langfuse covers **LLM semantics**; OpenTelemetry covers the **request/infra
trace**. With auto-instrumentation, each `POST /query` produces a span tree:

```
POST /query                      (express, inbound)
├─ interpret                     (custom stage span)
│  └─ POST api.openai.com/...    (outbound, auto — incl. latency)
└─ execute_plan  viz.type=...    (custom stage span)
   └─ GET clinicaltrials.gov/... (outbound fetch, auto)
```

Captured automatically: HTTP server + outbound `fetch`/HTTP (ClinicalTrials.gov,
OpenAI). Captured via `withSpan(...)`: the `interpret` and `execute_plan` stages.

## Modes (opt-in via env)

| Env | Behavior |
|---|---|
| *(unset)* | Disabled — no overhead. |
| `OTEL_ENABLED=true`, no endpoint | Spans printed to the **console** (zero infra). |
| `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` | Exported via **OTLP**. |

## Local trace viewer (bundled Jaeger)

```bash
npm run otel:up              # Jaeger UI: http://localhost:16686, OTLP in: :4318
```
Then in `.env`:
```
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```
`npm start`, fire a `/query`, open http://localhost:16686 → service `ct-viz-agent`.

```bash
npm run otel:down
```

## Optional: send OTel spans to Langfuse instead of Jaeger

Langfuse's server also accepts OTLP. Point the exporter at its OTLP endpoint with
Basic auth (base64 of `pk:sk`):
```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3001/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(pk-lf-...:sk-lf-...)>
```
Note: SDK-v3 Langfuse traces and these OTLP spans land as **separate** traces in
the Langfuse project (they are not merged into one tree).
