/**
 * Export handler (build artifact, zip or JSON response). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Dependencies injected via ExportHandlerDeps to avoid circular dependency with index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";

export interface ExportPayloadLike {
  format?: string;
}

export interface ExportOutcomeLike {
  artifact_base64: string;
  bytes: number;
  sha256: string;
  archive: Uint8Array;
}

export interface ExportHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  wantsZipResponse: (request: Request) => boolean;
  buildExportArtifact: (
    auth: AuthContext,
    supabase: SupabaseClient,
    maxBytes: number,
  ) => Promise<ExportOutcomeLike>;
  makeExportResponse: (
    outcome: ExportOutcomeLike,
    wantsZip: boolean,
    auth: AuthContext,
    rateHeaders: Record<string, string>,
  ) => Response;
  defaultMaxExportBytes: number;
}

export function createExportHandlers(
  requestDeps: ExportHandlerDeps,
  defaultDeps: ExportHandlerDeps,
): {
  handleExport: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleExport(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as ExportHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      const payload = await d.safeParseJson<ExportPayloadLike>(request);
      if (!payload.ok) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: payload.error } }, 400, rate.headers);
      }

      const wantsZip = d.wantsZipResponse(request);
      const maxBytes = Number(env.MAX_EXPORT_BYTES ?? d.defaultMaxExportBytes);
      const outcome = await d.buildExportArtifact(auth, supabase, maxBytes);

      return d.makeExportResponse(outcome, wantsZip, auth, rate.headers);
    },
  };
}
