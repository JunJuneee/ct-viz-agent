# `src/aggregate` — Aggregation & evidence (citation) module

A deterministic module that takes `NormalizedStudy[]` and aggregates it into
**data points** per chart type, **attaching a deep citation (NCT id + exact excerpt
+ link) to every datum**. The LLM is not involved at all; every number in the
response is computed here.

## File layout

| File | Responsibility |
|---|---|
| `dimensions.ts` | Category extraction per grouping (`categoryKeys`), numeric field extraction (`numericValue`), excerpt generation (`categoryExcerpt`), label mapping |
| `aggregators.ts` | Core aggregators — `countByDimension`, `timeSeries`, `histogram`, `scatter` |
| `network.ts` | Relationship network builder — bipartite (sponsor↔drug) / co-occurrence (drug↔drug) graphs |
| `citations.ts` | Per-datum citation attachment (`buildCitation`, `pickCitations`) |

## Per-aggregator behavior

### `countByDimension(studies, dim, opts)` — categorical count
- Counts trials per `dim` (phase, country, sponsor, status, intervention_type …).
- **Ranking support**: `opts.sortDir` (`"desc"`=most / `"asc"`=fewest, default desc) and `opts.topN`
  (default 20) handle "most/fewest/top N" queries precisely. Reports the number of truncated categories.
- When `opts.sortByKey` is true (mainly phase), sorts by key order (Phase 1, 2, 3…) and does not truncate.
- **Multi-valued dimensions** (phase/country/condition/intervention_type) can place one trial in
  several categories, so they are counted as "trial appearances" (noted in meta.units).

### `timeSeries(studies)` — yearly trend
- Groups by start year, **gap-filling missing years with 0** so a line chart draws a continuous axis.

### `histogram(studies, field, bucketSize?)` — numeric distribution
- Splits a numeric field such as enrollment into fixed-width buckets. When no bucket size is given,
  it auto-sizes to ~12 buckets using a 1/2/5×10ⁿ rule (`niceBucketSize`).

### `scatter(studies, x, y)` — relationship of two numerics
- One point per trial that has both axis values. Each point carries itself as a citation.

### `buildNetwork(studies, source, target)` — relationship graph
- `source !== target` → **bipartite graph** (e.g. a set of sponsor nodes ↔ a set of drug nodes).
- `source === target` → **co-occurrence graph** (drug pairs appearing in the same trial).
- Edge weight = number of trials linking the two nodes; node weight = number of trials it participates in (deduplicated).
- Node ids are namespaced as `group:name` (prevents sponsor/drug name collisions).
- Capped to the top edges (120) and node count to stay renderable; sets `truncated=true` when cut.

## Citation model

Every datum/edge carries up to `MAX_CITATIONS_PER_DATUM` citations of this shape:

```json
{ "nct_id": "NCT01234567",
  "excerpt": "Phase 3 — \"Phase 3 randomized study evaluating ...\"",
  "url": "https://clinicaltrials.gov/study/NCT01234567" }
```
- `excerpt` is **taken verbatim from the source record** (not summarized/generated). It presents
  evidence appropriate to the dimension (e.g. start date for a year group, location.country for a country group).
- The NCT ids of these citations are collected by `collectReferences` in `pipeline.ts` to assemble the
  top-level `references[]` (source cards: title, official title, sponsor, principal investigator, start date, link).

## Return contract

Each aggregator returns `CountResult { data, skipped, truncatedCategories }`:
- `skipped`: number of trials excluded because the field was missing → surfaced via `meta.warnings`.
- `truncatedCategories`: number of categories omitted by the top-N limit.

## How to extend

- **A new grouping dimension**: add it to `GROUP_BY_DIMENSIONS` in `types.ts` and to
  `categoryKeys`/`categoryExcerpt`/`dimensionLabel` in `dimensions.ts`, and `countByDimension` handles it automatically.

## Rationale — why these choices

- **Aggregate from real records (not LLM-generated, not count-only queries).** Computing
  counts in code keeps numbers exact and lets the same single pass attach **deep citations
  and reference cards** — the bonus traceability requirement needs the actual records.
- **Top-N category cap is display-only.** High-cardinality dimensions (sponsor, country)
  can have thousands of categories; we count *all* of them exactly, then show the top N for
  readability and report how many were omitted — counts are never distorted.
- **Multi-valued dimensions counted per appearance, and said so.** A trial can span several
  phases/countries; we count it in each and label `meta.units` accordingly rather than
  silently picking one.

> Full reasoning + tradeoffs for every decision: [`../../DESIGN_DECISIONS.md`](../../DESIGN_DECISIONS.md).

## Related modules

- Input: `NormalizedStudy[]` from [`../clinicaltrials`](../clinicaltrials/README.md)
- Output: `VizDatum[]` / network nodes & edges → assembled into a `VisualizationSpec` by `../pipeline.ts`
