# `src/clinicaltrials` — ClinicalTrials.gov API module

The module that fetches real clinical-trial records from the
[ClinicalTrials.gov Data API v2](https://clinicaltrials.gov/data-api/api) and
normalizes them into an analysis-friendly flat shape.
**Every number in the response ultimately comes from the real data this module fetches.**

## File layout

| File | Responsibility |
|---|---|
| `fields.ts` | The list of v2 field paths to request (`REQUESTED_FIELDS`) + a study URL builder. Only the necessary fields are specified to minimize payload (all verified against the live API) |
| `client.ts` | HTTP client — query URL building, **pagination**, **retry/backoff**, securing `totalCount`, error type (`CtgovError`) |
| `normalize.ts` | Converts complex raw records → `NormalizedStudy` (a flat domain object) |

## Core behavior

### 1. Query building & pagination (`client.ts`)
- `fetchStudies(params, onProgress?)` is called with `query.*` + `filter.*` parameters.
- **Full fetch by default**: when `config.maxStudies = 0` (unlimited), it follows
  `nextPageToken` to the end and retrieves **the entire match set** → counts are exact and
  `truncated=false`. Up to 1000 records per page (the API maximum). Setting `config.maxStudies`
  to a positive value stops at that count, and only then, if the match set is larger, marks
  `truncated=true` to honestly indicate a "sample".
- The `onProgress?: FetchProgress` callback reports `{ fetched, total, page }` per page →
  used to stream real-time progress as the SSE `fetch_progress` event.
- `countTotal=true` always secures the **total match count** (`totalCount`).

### 2. Robustness (`fetchWithRetry`)
- 5xx / 429 are retried up to 3 times with exponential backoff, with a 30s timeout (`AbortController`).
- 4xx and similar are returned immediately as `CtgovError` → `server.ts` maps them to `502`.

### 3. Normalization (`normalize.ts`)
Converts deep paths in the raw JSON into flat fields:

```
protocolSection.identificationModule.nctId        → nctId
protocolSection.identificationModule.briefTitle   → briefTitle
protocolSection.identificationModule.officialTitle → officialTitle   (for reference cards)
protocolSection.designModule.phases               → phases[]
protocolSection.statusModule.startDateStruct.date → startDate, startYear
protocolSection.sponsorCollaboratorsModule.leadSponsor → leadSponsor, sponsorClass
protocolSection.sponsorCollaboratorsModule.responsibleParty.investigatorFullName → investigator (PI, for reference cards)
protocolSection.conditionsModule.conditions       → conditions[]
protocolSection.armsInterventionsModule.interventions → interventions[{type,name}]
protocolSection.contactsLocationsModule.locations → countries[] (deduplicated)
protocolSection.designModule.enrollmentInfo.count → enrollment
```
> `officialTitle` and `investigator` are not used in visualization aggregation; they populate the
> source cards (official title, principal investigator) in the response `references[]`.
- Records without an `nctId` are discarded (every datum must be traceable).
- The phase enum is converted to a human-readable label (`PHASE3` → `Phase 3`).

## Filter mapping (reference)

This module passes the parameters produced by `queryBuilder.ts` straight to the API:

| Meaning | Parameter |
|---|---|
| condition / drug / sponsor / location | `query.cond` / `query.intr` / `query.spons` / `query.locn` |
| phase · date range · studyType | `filter.advanced` (Essie expression, e.g. `AREA[Phase](PHASE2 OR PHASE3)`) |
| recruitment status | `filter.overallStatus` (comma-separated) |

## Configuration

| Env | Meaning |
|---|---|
| `MAX_STUDIES` | Cap on records fetched per request. **`0`=unlimited (default)** → full fetch, exact counts. A positive value stops at that count (sample beyond it, `truncated=true`). |

## Rationale — why these choices

- **Full fetch by default (exact counts).** In a clinical context, a "sample that looks
  like the whole population" is dangerous, so we paginate everything and report exact
  numbers. The tradeoff is latency on huge queries — bounded by the optional `MAX_STUDIES`
  cap, and broad/filterless queries are stopped earlier by the agent's `needs_clarification` guard.
- **A field whitelist (`REQUESTED_FIELDS`), not the full record.** A trial record is huge;
  requesting only the ~12 fields we use cuts payload/latency and makes the normalizer's
  assumptions explicit.
- **Retry/backoff + timeout.** The live API has transient 429/5xx and slow responses;
  retrying transient failures (and failing fast on 4xx → `502`) keeps the service robust.

> Full reasoning + tradeoffs for every decision: [`../../DESIGN_DECISIONS.md`](../../DESIGN_DECISIONS.md).

## Related modules

- Input: the `queryBuilder` output from [`../agent`](../agent/README.md)
- Output: `NormalizedStudy[]` → [`../aggregate`](../aggregate/README.md)
