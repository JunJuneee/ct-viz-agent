import { z } from "zod";
import { TRIAL_PHASES, VISUALIZATION_TYPES } from "../types";

/**
 * Request schema. Only `query` is required. The optional structured fields let a
 * caller pin filters explicitly; when present they OVERRIDE whatever the LLM
 * infers, which is the safe direction (caller intent wins over inference).
 */
export const RequestSchema = z
  .object({
    query: z.string().min(1, "query must be a non-empty string").max(2000),
    drug_name: z.string().max(200).optional(),
    condition: z.string().max(200).optional(),
    sponsor: z.string().max(200).optional(),
    country: z.string().max(200).optional(),
    trial_phase: z
      .union([z.enum(TRIAL_PHASES), z.array(z.enum(TRIAL_PHASES))])
      .optional(),
    status: z.array(z.string().max(50)).optional(),
    study_type: z.string().max(50).optional(),
    start_year: z.number().int().min(1900).max(2100).optional(),
    end_year: z.number().int().min(1900).max(2100).optional(),
    /** Force a specific visualization type, bypassing the agent's choice. */
    visualization_type: z.enum(VISUALIZATION_TYPES).optional(),
  })
  .strict();

export type RequestInput = z.infer<typeof RequestSchema>;
