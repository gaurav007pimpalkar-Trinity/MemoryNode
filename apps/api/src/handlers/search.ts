/**
 * Search handler (hybrid search + pagination + has_more/total). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Dependencies injected via SearchHandlerDeps to avoid circular dependency with index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import { SearchPayloadSchema, parseWithSchema, type SearchPayload } from "../contracts/index.js";

export type { SearchPayload } from "../contracts/index.js";

export interface SearchOutcome {
  results: Array<{
    chunk_id: string;
    memory_id: string;
    chunk_index: number;
    text: string;
    score: number;
  }>;
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface SearchHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  checkCapsAndMaybeRespond: (
    jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
    auth: AuthContext,
    supabase: SupabaseClient,
    deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
    rateHeaders: Record<string, string> | undefined,
    env: Env,
    logCtx?: { requestId?: string; route?: string; method?: string },
  ) => Promise<Response | null>;
  performSearch: (
    auth: AuthContext,
    payload: SearchPayload,
    env: Env,
    supabase: SupabaseClient,
  ) => Promise<SearchOutcome>;
  emitProductEvent: (
    supabase: SupabaseClient,
    eventName: string,
    ctx: {
      workspaceId?: string;
      requestId?: string;
      route?: string;
      method?: string;
      status?: number;
      effectivePlan?: AuthContext["plan"];
      planStatus?: AuthContext["planStatus"];
    },
    props?: Record<string, unknown>,
    ensureUnique?: boolean,
  ) => Promise<void>;
  effectivePlan: (plan: AuthContext["plan"], status?: AuthContext["planStatus"]) => AuthContext["plan"];
}

export function createSearchHandlers(
  requestDeps: SearchHandlerDeps,
  defaultDeps: SearchHandlerDeps,
): {
  handleSearch: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleSearch(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as SearchHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env);
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
        { requestId, route: "/v1/search", method: "POST" },
      );
      if (capResponse) return capResponse;

      const outcome = await d.performSearch(auth, parseResult.data, env, supabase);

      void d.emitProductEvent(
        supabase,
        "first_search_success",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/search",
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
          results: outcome.results,
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
