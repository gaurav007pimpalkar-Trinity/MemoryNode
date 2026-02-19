/**
 * Import handler (artifact_base64 + mode). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Dependencies injected via ImportHandlerDeps to avoid circular dependency with index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import { ImportPayloadSchema, parseWithSchema } from "../contracts/index.js";
import type { ImportMode, ImportPayload } from "../contracts/index.js";

export type { ImportMode, ImportPayload };
export type ImportPayloadLike = ImportPayload;

export interface ImportOutcomeLike {
  imported_memories: number;
  imported_chunks: number;
}

export interface ImportHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  importArtifact: (
    auth: AuthContext,
    supabase: SupabaseClient,
    artifactBase64: string,
    maxBytes: number,
    mode?: ImportMode,
  ) => Promise<ImportOutcomeLike>;
  defaultMaxImportBytes: number;
}

export function createImportHandlers(
  requestDeps: ImportHandlerDeps,
  defaultDeps: ImportHandlerDeps,
): {
  handleImport: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleImport(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as ImportHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      const parseResult = await parseWithSchema(ImportPayloadSchema, request);
      if (!parseResult.ok) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: parseResult.error,
              ...(parseResult.details ? { details: parseResult.details } : {}),
            },
          },
          400,
          rate.headers,
        );
      }
      const payload = parseResult.data;

      const maxBytes = Number(env.MAX_IMPORT_BYTES ?? d.defaultMaxImportBytes);
      const outcome = await d.importArtifact(
        auth,
        supabase,
        payload.artifact_base64,
        maxBytes,
        payload.mode,
      );
      return jsonResponse(
        { imported_memories: outcome.imported_memories, imported_chunks: outcome.imported_chunks },
        200,
        rate.headers,
      );
    },
  };
}
