import { config } from "../config";
import { STUDY_URL } from "../clinicaltrials/fields";
import { Citation, NormalizedStudy } from "../types";

/**
 * Deep-citation support (bonus). Every visualized datum carries references to the
 * underlying trial records that produced it: an NCT id, an EXACT excerpt taken
 * from the record (never paraphrased), and a deep link to the study page.
 */
export function buildCitation(study: NormalizedStudy, excerpt: string): Citation {
  return {
    nct_id: study.nctId,
    excerpt: excerpt.slice(0, 300),
    url: STUDY_URL(study.nctId),
  };
}

/**
 * Pick up to maxCitationsPerDatum citations from the studies contributing to a
 * datum. `excerptFor` returns the exact supporting text for a given study.
 */
export function pickCitations(
  studies: NormalizedStudy[],
  excerptFor: (s: NormalizedStudy) => string,
  max = config.maxCitationsPerDatum,
): Citation[] {
  return studies.slice(0, max).map((s) => buildCitation(s, excerptFor(s)));
}
