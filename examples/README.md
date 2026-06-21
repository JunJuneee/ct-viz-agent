# `examples` — example runner & output module

A module that runs representative queries through the agent to produce **real JSON
outputs**. It serves as the README's "Example Runs" material and as an
**end-to-end smoke test** against the live API.

## Layout

| Path | Description |
|---|---|
| `run-examples.ts` | Runs the representative queries via `runAgent()` and saves results to `outputs/` |
| `outputs/*.json` | The actual `{ request, response }` output for each query |

## Run

```bash
npm run examples
```

## Included examples (full coverage of visualization types)

| File | Query intent | Visualization type |
|---|---|---|
| `01_time_trend_pembrolizumab.json` | yearly trend | `time_series` |
| `02_phase_distribution_melanoma.json` | phase distribution | `bar_chart` |
| `03_compare_drugs.json` | drug comparison | `grouped_bar_chart` |
| `04_geographic_diabetes.json` | recruitment by country | `bar_chart` (country) |
| `05_sponsor_drug_network.json` | sponsor↔drug relationships | `network_graph` |
| `06_enrollment_histogram.json` | enrollment-size distribution | `histogram` |
| `07_ranking_top_countries.json` | country ranking (top 10) | `bar_chart` (sort/topN) |
| `08_out_of_scope.json` | out of scope (drug price/efficacy) | none (`status: unsupported`) |
| `09_needs_clarification.json` | overly vague question | none (`status: needs_clarification`) |

## Notes

- It calls the live ClinicalTrials.gov API directly, so the numbers may change
  depending on when it runs.
- Without `OPENAI_API_KEY`, outputs are generated with `interpreter: "fallback-rules"`
  (the data pipeline is identical). Setting the key switches to `interpreter: "llm"`
  for more accurate natural-language interpretation.
- When validating outputs, check: the `visualization.type`/`encoding`/`data` shape,
  each datum's `citations` (real NCT links), and `meta`'s
  `totalMatchingTrials` · `truncated` · `apiRequests`.
