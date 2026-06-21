import { config } from "../config";
import { REQUESTED_FIELDS } from "./fields";

/** Raw study shape returned by the API (only the parts we read). */
export interface RawStudy {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string; officialTitle?: string };
    statusModule?: {
      overallStatus?: string;
      startDateStruct?: { date?: string };
    };
    designModule?: {
      phases?: string[];
      studyType?: string;
      enrollmentInfo?: { count?: number };
    };
    sponsorCollaboratorsModule?: {
      leadSponsor?: { name?: string; class?: string };
      responsibleParty?: { investigatorFullName?: string };
    };
    conditionsModule?: { conditions?: string[] };
    armsInterventionsModule?: {
      interventions?: { type?: string; name?: string }[];
    };
    contactsLocationsModule?: {
      locations?: { country?: string; city?: string }[];
    };
  };
}

export interface CtgovQueryParams {
  "query.cond"?: string;
  "query.intr"?: string;
  "query.spons"?: string;
  "query.locn"?: string;
  "query.term"?: string;
  /** Essie advanced filter expression (phases, dates, study type, status). */
  "filter.advanced"?: string;
  "filter.overallStatus"?: string;
}

export interface FetchResult {
  studies: RawStudy[];
  totalCount: number;
  truncated: boolean;
  /** Exact request URLs issued (for traceability/debugging). */
  requestUrls: string[];
}

const PAGE_SIZE = 1000; // API maximum per page.

/** Per-page progress callback so callers (e.g. SSE) can stream fetch status. */
export type FetchProgress = (p: { fetched: number; total: number; page: number }) => void;

function buildUrl(params: CtgovQueryParams, pageSize: number, pageToken?: string): string {
  const url = new URL(`${config.ctgovBaseUrl}/studies`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  url.searchParams.set("fields", REQUESTED_FIELDS.join(","));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("countTotal", "true");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

/**
 * Fetch ALL matching studies, following nextPageToken until exhausted. There is
 * no sampling by default (config.maxStudies = 0 → unlimited), so aggregated
 * counts are exact. A positive config.maxStudies caps the fetch for constrained
 * environments. onProgress fires after every page for streaming UIs.
 */
export async function fetchStudies(
  params: CtgovQueryParams,
  onProgress?: FetchProgress,
): Promise<FetchResult> {
  const studies: RawStudy[] = [];
  const requestUrls: string[] = [];
  const cap = config.maxStudies > 0 ? config.maxStudies : Infinity;
  const pageSize = Math.min(PAGE_SIZE, cap);
  let totalCount = 0;
  let pageToken: string | undefined;
  let page = 0;

  while (studies.length < cap) {
    const url = buildUrl(params, pageSize, pageToken);
    requestUrls.push(url);
    page++;

    const res = await fetchWithRetry(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CtgovError(
        `ClinicalTrials.gov API returned ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
        res.status,
      );
    }

    const json = (await res.json()) as {
      studies?: RawStudy[];
      totalCount?: number;
      nextPageToken?: string;
    };

    totalCount = json.totalCount ?? totalCount;
    if (json.studies?.length) studies.push(...json.studies);
    onProgress?.({ fetched: studies.length, total: totalCount, page });

    if (!json.nextPageToken || !json.studies?.length) break;
    pageToken = json.nextPageToken;
  }

  const capped = cap === Infinity ? studies : studies.slice(0, cap);
  return {
    studies: capped,
    totalCount: totalCount || capped.length,
    truncated: totalCount > capped.length,
    requestUrls,
  };
}

export class CtgovError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CtgovError";
    this.status = status;
  }
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        // Retry transient 5xx / 429; return everything else to the caller.
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`transient ${res.status}`);
        } else {
          return res;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(250 * 2 ** i);
  }
  throw new CtgovError(
    `ClinicalTrials.gov request failed after ${attempts} attempts: ${String(lastErr)}`,
    502,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
