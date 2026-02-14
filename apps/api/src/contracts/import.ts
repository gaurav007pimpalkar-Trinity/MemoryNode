/**
 * Zod schemas for import API. Phase 5 (Option A). Source of truth for POST /v1/import.
 */

import { z } from "zod";

export const ImportModeSchema = z.enum([
  "upsert",
  "skip_existing",
  "error_on_conflict",
  "replace_ids",
  "replace_all",
]);
export type ImportMode = z.infer<typeof ImportModeSchema>;

export const ImportPayloadSchema = z.object({
  artifact_base64: z.string().min(1, "artifact_base64 is required"),
  mode: ImportModeSchema.optional(),
});

export type ImportPayload = z.infer<typeof ImportPayloadSchema>;
