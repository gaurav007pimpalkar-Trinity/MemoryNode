/**
 * Zod schemas for search/context API. Phase 5 (Option A). Source of truth for POST /v1/search and POST /v1/context.
 */

import { z } from "zod";
import { MAX_QUERY_CHARS, MAX_TOPK } from "../limits.js";

const metadataValue = z.union([z.string(), z.number(), z.boolean()]);
const filtersSchema = z
  .object({
    metadata: z.record(z.string(), metadataValue).optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
  })
  .optional();

export const SearchPayloadSchema = z.object({
  user_id: z.string().min(1, "user_id is required"),
  namespace: z.string().optional(),
  query: z.string().min(1, "query is required").max(MAX_QUERY_CHARS, `query exceeds ${MAX_QUERY_CHARS} chars`),
  top_k: z.number().int().min(1).max(MAX_TOPK).optional(),
  page: z.number().int().min(1).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
  filters: filtersSchema,
});

export type SearchPayload = z.infer<typeof SearchPayloadSchema>;
