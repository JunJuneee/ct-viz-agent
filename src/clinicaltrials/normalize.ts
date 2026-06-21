import { NormalizedStudy } from "../types";
import { RawStudy } from "./client";

const PHASE_LABELS: Record<string, string> = {
  EARLY_PHASE1: "Early Phase 1",
  PHASE1: "Phase 1",
  PHASE2: "Phase 2",
  PHASE3: "Phase 3",
  PHASE4: "Phase 4",
  NA: "Not Applicable",
};

/** Human-friendly phase label, falling back to the raw enum if unknown. */
export const phaseLabel = (raw: string): string => PHASE_LABELS[raw] ?? raw;

function parseYear(date?: string | null): number | null {
  if (!date) return null;
  const m = /^(\d{4})/.exec(date);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Flatten a raw API record into the analysis-friendly NormalizedStudy shape. */
export function normalizeStudy(raw: RawStudy): NormalizedStudy | null {
  const p = raw.protocolSection;
  const nctId = p?.identificationModule?.nctId;
  if (!nctId) return null; // every datum must be traceable to an NCT id.

  const startDate = p?.statusModule?.startDateStruct?.date ?? null;
  const countries = Array.from(
    new Set(
      (p?.contactsLocationsModule?.locations ?? [])
        .map((l) => l.country)
        .filter((c): c is string => Boolean(c)),
    ),
  );

  const interventions = (p?.armsInterventionsModule?.interventions ?? [])
    .filter((i) => i.name)
    .map((i) => ({ type: i.type ?? "UNKNOWN", name: i.name as string }));

  const enrollment = p?.designModule?.enrollmentInfo?.count;

  return {
    nctId,
    briefTitle: p?.identificationModule?.briefTitle ?? "",
    officialTitle: p?.identificationModule?.officialTitle ?? null,
    investigator:
      p?.sponsorCollaboratorsModule?.responsibleParty?.investigatorFullName ?? null,
    phases: p?.designModule?.phases ?? [],
    studyType: p?.designModule?.studyType ?? null,
    overallStatus: p?.statusModule?.overallStatus ?? null,
    startDate,
    startYear: parseYear(startDate),
    leadSponsor: p?.sponsorCollaboratorsModule?.leadSponsor?.name ?? null,
    sponsorClass: p?.sponsorCollaboratorsModule?.leadSponsor?.class ?? null,
    conditions: p?.conditionsModule?.conditions ?? [],
    interventions,
    countries,
    enrollment: typeof enrollment === "number" ? enrollment : null,
  };
}

export function normalizeStudies(raw: RawStudy[]): NormalizedStudy[] {
  return raw
    .map(normalizeStudy)
    .filter((s): s is NormalizedStudy => s !== null);
}
