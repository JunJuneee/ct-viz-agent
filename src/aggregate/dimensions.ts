import { GroupByDimension, NormalizedStudy, NumericField } from "../types";
import { phaseLabel } from "../clinicaltrials/normalize";

/**
 * For a given grouping dimension, return the category label(s) a study belongs
 * to. Multi-valued dimensions (phase, country, condition, intervention_type)
 * return several labels, so the study is counted once per category it touches —
 * documented as "trial appearances" in the response units.
 */
export function categoryKeys(
  study: NormalizedStudy,
  dim: GroupByDimension,
): string[] {
  switch (dim) {
    case "phase":
      return study.phases.length ? study.phases.map(phaseLabel) : ["Not Specified"];
    case "year":
      return study.startYear ? [String(study.startYear)] : [];
    case "country":
      return study.countries;
    case "sponsor":
      return study.leadSponsor ? [study.leadSponsor] : [];
    case "sponsor_class":
      return study.sponsorClass ? [study.sponsorClass] : [];
    case "intervention_type":
      return Array.from(new Set(study.interventions.map((i) => i.type)));
    case "condition":
      return study.conditions;
    case "status":
      return study.overallStatus ? [study.overallStatus] : [];
    case "study_type":
      return study.studyType ? [study.studyType] : [];
    default:
      return [];
  }
}

/** True for dimensions where one study can land in multiple categories. */
export function isMultiValued(dim: GroupByDimension): boolean {
  return ["phase", "country", "condition", "intervention_type"].includes(dim);
}

/** A short, exact excerpt from the study that supports a category membership. */
export function categoryExcerpt(
  study: NormalizedStudy,
  dim: GroupByDimension,
  category: string,
): string {
  const title = study.briefTitle || study.nctId;
  switch (dim) {
    case "phase":
      return `${category} — "${title}"`;
    case "year":
      return `Start date ${study.startDate} — "${title}"`;
    case "country":
      return `Location country: ${category} — "${title}"`;
    case "sponsor":
      return `Lead sponsor: ${category} — "${title}"`;
    case "sponsor_class":
      return `Sponsor class: ${category} — "${title}"`;
    case "intervention_type":
      return `Intervention type: ${category} — "${title}"`;
    case "condition":
      return `Condition: ${category} — "${title}"`;
    case "status":
      return `Overall status: ${category} — "${title}"`;
    case "study_type":
      return `Study type: ${category} — "${title}"`;
    default:
      return title;
  }
}

export function numericValue(
  study: NormalizedStudy,
  field: NumericField,
): number | null {
  switch (field) {
    case "enrollment":
      return study.enrollment;
    case "start_year":
      return study.startYear;
    default:
      return null;
  }
}

export const numericLabel: Record<NumericField, string> = {
  enrollment: "Enrollment",
  start_year: "Start Year",
};

export const dimensionLabel: Record<GroupByDimension, string> = {
  phase: "Phase",
  year: "Year",
  country: "Country",
  sponsor: "Sponsor",
  sponsor_class: "Sponsor Class",
  intervention_type: "Intervention Type",
  condition: "Condition",
  status: "Overall Status",
  study_type: "Study Type",
};
