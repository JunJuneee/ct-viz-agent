import dotenv from "dotenv";

dotenv.config();

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: intEnv("PORT", 3000),
  openAiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openAiModel: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  /**
   * Optional hard ceiling on records fetched per request. 0 = unlimited: the
   * client paginates through ALL matching trials (no truncation, exact counts).
   * Set a positive value only to bound cost/latency in constrained environments.
   */
  maxStudies: intEnv("MAX_STUDIES", 0),
  /** Citations attached to each visualized datum (bonus traceability). */
  maxCitationsPerDatum: intEnv("MAX_CITATIONS_PER_DATUM", 3),
  /** ClinicalTrials.gov Data API v2 base URL. */
  ctgovBaseUrl: "https://clinicaltrials.gov/api/v2",
} as const;

/** Whether the LLM interpreter is available; otherwise we use the fallback parser. */
export const llmEnabled = (): boolean => config.openAiApiKey.length > 0;
