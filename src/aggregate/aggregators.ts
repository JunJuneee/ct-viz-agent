import {
  GroupByDimension,
  NormalizedStudy,
  NumericField,
  SortDirection,
  VizDatum,
} from "../types";
import { pickCitations } from "./citations";
import {
  categoryExcerpt,
  categoryKeys,
  numericLabel,
  numericValue,
} from "./dimensions";

const DEFAULT_TOP_N = 20;

interface Bucket {
  studies: NormalizedStudy[];
}

function group(
  studies: NormalizedStudy[],
  dim: GroupByDimension,
): { map: Map<string, Bucket>; skipped: number } {
  const map = new Map<string, Bucket>();
  let skipped = 0;
  for (const s of studies) {
    const keys = categoryKeys(s, dim);
    if (keys.length === 0) {
      skipped++;
      continue;
    }
    for (const k of keys) {
      let b = map.get(k);
      if (!b) {
        b = { studies: [] };
        map.set(k, b);
      }
      b.studies.push(s);
    }
  }
  return { map, skipped };
}

export interface CountResult {
  data: VizDatum[];
  skipped: number;
  /** Number of categories dropped by the top-N cap. */
  truncatedCategories: number;
}

/**
 * Count trials by a categorical dimension, sorted descending by count and capped
 * to topN categories. Each datum keeps deep citations to contributing trials.
 */
export function countByDimension(
  studies: NormalizedStudy[],
  dim: GroupByDimension,
  opts: { topN?: number; sortByKey?: boolean; sortDir?: SortDirection } = {},
): CountResult {
  const { map, skipped } = group(studies, dim);
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const dir = opts.sortDir ?? "desc"; // ranking default: most → fewest.

  let entries = Array.from(map.entries());
  entries.sort((a, b) =>
    opts.sortByKey
      ? a[0].localeCompare(b[0], undefined, { numeric: true })
      : dir === "asc"
        ? a[1].studies.length - b[1].studies.length
        : b[1].studies.length - a[1].studies.length,
  );

  const truncatedCategories = Math.max(0, entries.length - topN);
  if (!opts.sortByKey) entries = entries.slice(0, topN);

  const data: VizDatum[] = entries.map(([category, bucket]) => ({
    category,
    trial_count: bucket.studies.length,
    citations: pickCitations(bucket.studies, (s) =>
      categoryExcerpt(s, dim, category),
    ),
  }));

  return { data, skipped, truncatedCategories };
}

/**
 * Trials per year (time series). Sorted ascending by year and gap-filled with
 * zero-count years so a line renderer draws a continuous axis.
 */
export function timeSeries(studies: NormalizedStudy[]): CountResult {
  const { map, skipped } = group(studies, "year");
  const years = Array.from(map.keys()).map(Number).filter(Number.isFinite);
  if (years.length === 0) return { data: [], skipped, truncatedCategories: 0 };

  const min = Math.min(...years);
  const max = Math.max(...years);
  const data: VizDatum[] = [];
  for (let y = min; y <= max; y++) {
    const bucket = map.get(String(y));
    data.push({
      year: y,
      trial_count: bucket ? bucket.studies.length : 0,
      citations: bucket
        ? pickCitations(bucket.studies, (s) => categoryExcerpt(s, "year", String(y)))
        : [],
    });
  }
  return { data, skipped, truncatedCategories: 0 };
}

/** Histogram of a numeric field into fixed-width buckets. */
export function histogram(
  studies: NormalizedStudy[],
  field: NumericField,
  bucketSize?: number,
): CountResult {
  const valued = studies
    .map((s) => ({ s, v: numericValue(s, field) }))
    .filter((x): x is { s: NormalizedStudy; v: number } => x.v !== null && x.v >= 0);

  const skipped = studies.length - valued.length;
  if (valued.length === 0) return { data: [], skipped, truncatedCategories: 0 };

  const max = Math.max(...valued.map((x) => x.v));
  const size = bucketSize ?? niceBucketSize(max);

  const buckets = new Map<number, NormalizedStudy[]>();
  for (const { s, v } of valued) {
    const idx = Math.floor(v / size);
    const arr = buckets.get(idx) ?? [];
    arr.push(s);
    buckets.set(idx, arr);
  }

  const data: VizDatum[] = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([idx, group]) => {
      const lo = idx * size;
      const hi = lo + size - 1;
      return {
        bucket: `${lo}-${hi}`,
        bucket_start: lo,
        bucket_end: hi,
        trial_count: group.length,
        citations: pickCitations(
          group,
          (s) => `${numericLabel[field]}: ${numericValue(s, field)} — "${s.briefTitle || s.nctId}"`,
        ),
      };
    });

  return { data, skipped, truncatedCategories: 0 };
}

/** Scatter plot of two numeric fields; one point per trial with both values. */
export function scatter(
  studies: NormalizedStudy[],
  x: NumericField,
  y: NumericField,
  limit = 500,
): CountResult {
  const points = studies
    .map((s) => ({ s, xv: numericValue(s, x), yv: numericValue(s, y) }))
    .filter(
      (p): p is { s: NormalizedStudy; xv: number; yv: number } =>
        p.xv !== null && p.yv !== null,
    );

  const skipped = studies.length - points.length;
  const capped = points.slice(0, limit);

  const data: VizDatum[] = capped.map(({ s, xv, yv }) => ({
    x: xv,
    y: yv,
    nct_id: s.nctId,
    label: s.briefTitle,
    citations: [
      {
        nct_id: s.nctId,
        excerpt: `${numericLabel[x]}: ${xv}, ${numericLabel[y]}: ${yv} — "${s.briefTitle || s.nctId}"`,
        url: `https://clinicaltrials.gov/study/${s.nctId}`,
      },
    ],
  }));

  return {
    data,
    skipped,
    truncatedCategories: Math.max(0, points.length - capped.length),
  };
}

/** Round bucket size up to a "nice" 1/2/5 x 10^n value targeting ~12 buckets. */
function niceBucketSize(max: number): number {
  const target = max / 12;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(target, 1))));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= target) return m * pow;
  }
  return 10 * pow;
}
