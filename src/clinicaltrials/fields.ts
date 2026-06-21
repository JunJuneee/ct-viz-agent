/**
 * The exact set of ClinicalTrials.gov v2 field paths we request. Keeping this
 * list small reduces payload size and makes the normalizer's assumptions explicit.
 * All paths verified against the live API (2025).
 */
export const REQUESTED_FIELDS = [
  "protocolSection.identificationModule.nctId",
  "protocolSection.identificationModule.briefTitle",
  "protocolSection.identificationModule.officialTitle",
  "protocolSection.statusModule.overallStatus",
  "protocolSection.statusModule.startDateStruct.date",
  "protocolSection.designModule.phases",
  "protocolSection.designModule.studyType",
  "protocolSection.designModule.enrollmentInfo.count",
  "protocolSection.sponsorCollaboratorsModule.leadSponsor.name",
  "protocolSection.sponsorCollaboratorsModule.leadSponsor.class",
  "protocolSection.sponsorCollaboratorsModule.responsibleParty.investigatorFullName",
  "protocolSection.conditionsModule.conditions",
  "protocolSection.armsInterventionsModule.interventions",
  "protocolSection.contactsLocationsModule.locations",
] as const;

export const STUDY_URL = (nctId: string): string =>
  `https://clinicaltrials.gov/study/${nctId}`;
