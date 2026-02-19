/**
 * Context handler (search-derived context_text + citations). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Uses same deps as search (performSearch, caps, events). Dependencies injected via ContextHandlerDeps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import type { SearchHandlerDeps } from "./search.js";
import { SearchPayloadSchema, parseWithSchema } from "../contracts/index.js";

export type ContextHandlerDeps = SearchHandlerDeps;

export function createContextHandlers(
  requestDeps: ContextHandlerDeps,
  defaultDeps: ContextHandlerDeps,
): {
  handleContext: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleContext(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as ContextHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }
      const parseResult = await parseWithSchema(SearchPayloadSchema, request);
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

      const capResponse = await d.checkCapsAndMaybeRespond(
        jsonResponse,
        auth,
        supabase,
        { writesDelta: 0, readsDelta: 1, embedsDelta: 1 },
        rate.headers,
        env,
        { requestId, route: "/v1/context", method: "POST" },
      );
      if (capResponse) return capResponse;

      const outcome = await d.performSearch(auth, parseResult.data, env, supabase);
      const results = outcome.results;
      const lines: string[] = [];
      const citations = results.map((res, idx) => {
        lines.push(`[-${idx + 1}-] ${res.text}`);
        return {
          i: idx + 1,
          chunk_id: res.chunk_id,
          memory_id: res.memory_id,
          chunk_index: res.chunk_index,
        };
      });

      void d.emitProductEvent(
        supabase,
        "first_context_success",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/context",
          method: "POST",
          status: 200,
          effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
          planStatus: auth.planStatus,
        },
        { body_bytes: Number(request.headers.get("content-length") ?? "0") || undefined },
        true,
      );

      return jsonResponse(
        {
          context_text: lines.join("\n\n"),
          citations,
          page: outcome.page,
          page_size: outcome.page_size,
          total: outcome.total,
          has_more: outcome.has_more,
        },
        200,
        rate.headers,
      );
    },
  };
}
