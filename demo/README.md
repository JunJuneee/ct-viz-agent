# `demo` — zero-build frontend demo module

A **(bonus) demo UI** that actually renders the backend's structured responses.
It runs as a single static HTML file with no build step, served by the app at `/demo`.

## Layout

| File | Description |
|---|---|
| `index.html` | Query input → **subscribe to `GET /query/stream` (SSE)** → step-by-step streaming display + chart + source cards + verification toggles |

## Run

```bash
npm start
# in the browser:
open http://localhost:3000/demo
```

## SSE streaming (EventSource)

Instead of `POST /query`, the demo subscribes to **`GET /query/stream`** via
`EventSource` and shows the processing in real time:

| Event | Display |
|---|---|
| `status` | spinner + current stage message |
| `interpretation` | 🧠 agent-interpretation panel (plan · filters · notes · confidence) |
| `fetch_progress` | "N / total trials (page k)" live progress |
| `result` | final chart + source cards + raw JSON |
| `done` / `error` | completion / error display |

## Rendering

- **Charts**: [Chart.js](https://www.chartjs.org/) (CDN) — `bar_chart`, `grouped_bar_chart`,
  `time_series` (line), `histogram` (bar), `scatter_plot` (scatter), dispatched by the
  response's `type`.
- **Network**: [vis-network](https://visjs.github.io/vis-network/) (CDN) — renders the
  `network_graph`'s `nodes`/`edges` in a force layout, colored by group.
- **Source cards (References)**: renders `references[]` as ClinicalTrials.gov record cards
  (badge · title · official title · sponsor · NCT link · start date · investigator),
  shown collapsibly (`<details>`).
- All rendering is driven **only by the backend response's `encoding` · `data` ·
  `references`** → demonstrating output that "a frontend can render without guessing."

## Interaction by status (`visualization=null`)

When no chart can be produced (per the backend's `meta.status`), an appropriate UI is
shown instead of a chart:

- **`needs_clarification`** → 🤔 a **narrow-the-search form** (shown above the
  interpretation panel): Condition/Drug/Country/Sponsor/Start-year inputs + quick
  condition chips. Clicking "Search with these filters →" **re-issues the SSE request**
  with the original question plus the filters (`run(extra)` → structured fields appended
  to the query string).
- **`unsupported`** → 🚫 an out-of-scope message (suggesting a clinical-trials question).
  No retry form.

## Features

- Click an example chip at the top to run a query instantly.
- The result card summarizes `meta`: `interpreter` / `confidence` / analyzed count /
  `units` / `notes` / `warnings`.
- Verification toggles: "Raw structured response (JSON)", "① LLM-inferred plan (QueryPlan)",
  "② ClinicalTrials.gov API request & response sample" (the actual request URLs are
  clickable to inspect the API response).

## Notes

- Because it uses CDNs (Chart.js, vis-network), the demo rendering needs an internet
  connection (the backend API itself works independently).
- The demo is a bonus; the evaluation focus is the **backend + structured output**.
