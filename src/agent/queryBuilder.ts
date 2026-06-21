import { CtgovQueryParams } from "../clinicaltrials/client";
import { PlanFilters } from "../types";

/**
 * Translate structured PlanFilters into ClinicalTrials.gov v2 query parameters.
 * Text filters map to dedicated query.* params; phase / studyType / date-range
 * map to a single Essie `filter.advanced` expression; status uses the dedicated
 * filter.overallStatus param. All expressions verified against the live API.
 */
export function buildQueryParams(filters: PlanFilters): CtgovQueryParams {
  const params: CtgovQueryParams = {};

  if (filters.condition) params["query.cond"] = filters.condition;
  if (filters.intervention) params["query.intr"] = filters.intervention;
  if (filters.sponsor) params["query.spons"] = filters.sponsor;
  if (filters.location) params["query.locn"] = filters.location;
  if (filters.term) params["query.term"] = filters.term;

  const advanced: string[] = [];

  if (filters.phase?.length) {
    advanced.push(`AREA[Phase](${filters.phase.join(" OR ")})`);
  }
  if (filters.studyType) {
    advanced.push(`AREA[StudyType]${filters.studyType.toUpperCase()}`);
  }
  const range = dateRange(filters.startYearMin, filters.startYearMax);
  if (range) advanced.push(`AREA[StartDate]${range}`);

  if (advanced.length) params["filter.advanced"] = advanced.join(" AND ");

  if (filters.status?.length) {
    params["filter.overallStatus"] = filters.status
      .map((s) => s.toUpperCase())
      .join(",");
  }

  return params;
}

function dateRange(min?: number, max?: number): string | null {
  if (typeof min !== "number" && typeof max !== "number") return null;
  const lo = typeof min === "number" ? `${min}-01-01` : "MIN";
  const hi = typeof max === "number" ? `${max}-12-31` : "MAX";
  return `RANGE[${lo},${hi}]`;
}
