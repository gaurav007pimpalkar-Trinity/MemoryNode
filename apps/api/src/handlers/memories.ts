/**
 * Memory CRUD handlers. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * All dependencies injected via MemoryHandlerDeps to avoid circular dependency with index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import { MemoryInsertSchema, parseWithSchema } from "../contracts/index.js";

export type { MemoryInsertPayload } from "../contracts/index.js";

export type MetadataFilter = Record<string, string | number | boolean>;

export interface MemoryListParams {
  page: number;
  page_size: number;
  namespace?: string;
  user_id?: string;
  filters: {
    metadata?: MetadataFilter;
    start_time?: string;
    end_time?: string;
  };
}

export interface ListOutcome {
  results: {
    id: string;
    user_id: string;
    namespace: string;
    text: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface MemoryHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  chunkText: (text: string) => string[];
  embedText: (texts: string[], env: Env) => Promise<number[][]>;
  todayUtc: () => string;
  vectorToPgvectorString: (vector: number[]) => string;
  emitProductEvent: (
    supabase: SupabaseClient,
    eventName: string,
    ctx: { workspaceId?: string; requestId?: string; route?: string; method?: string; status?: number; effectivePlan?: AuthContext["plan"]; planStatus?: AuthContext["planStatus"] },
    props?: Record<string, unknown>,
    ensureUnique?: boolean,
  ) => Promise<void>;
  bumpUsage: (
    supabase: SupabaseClient,
    workspaceId: string,
    day: string,
    deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
  ) => Promise<unknown>;
  effectivePlan: (plan: AuthContext["plan"], status?: AuthContext["planStatus"]) => AuthContext["plan"];
  normalizeMemoryListParams: (url: URL) => MemoryListParams;
  performListMemories: (auth: AuthContext, params: MemoryListParams, supabase: SupabaseClient) => Promise<ListOutcome>;
  deleteMemoryCascade: (supabase: SupabaseClient, workspaceId: string, memoryId: string) => Promise<boolean>;
  checkCapsAndMaybeRespond: (
    jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
    auth: AuthContext,
    supabase: SupabaseClient,
    deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
    rateHeaders: Record<string, string> | undefined,
    env: Env,
    logCtx?: { requestId?: string; route?: string; method?: string },
  ) => Promise<Response | null>;
}

const DEFAULT_NAMESPACE = "default";

export function createMemoryHandlers(
  requestDeps: MemoryHandlerDeps,
  defaultDeps: MemoryHandlerDeps,
): {
  handleCreateMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleListMemories: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleGetMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    memoryId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    memoryId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleCreateMemory(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      auditCtx.workspaceId = auth.workspaceId;
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const parseResult = await parseWithSchema(MemoryInsertSchema, request);
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

      const { user_id, text, metadata, namespace } = parseResult.data;
      const namespaceVal = namespace ?? DEFAULT_NAMESPACE;

      const chunks = d.chunkText(text);
      const chunkCount = chunks.length;

      const capResponse = await d.checkCapsAndMaybeRespond(
        jsonResponse,
        auth,
        supabase,
        { writesDelta: 1, readsDelta: 0, embedsDelta: chunkCount },
        rate.headers,
        env,
        { requestId, route: "/v1/memories", method: "POST" },
      );
      if (capResponse) return capResponse;

      const today = d.todayUtc();
      const embeddings = await d.embedText(chunks, env);

      const { data: memoryInsert, error: memoryError } = await supabase
        .from("memories")
        .insert({
          workspace_id: auth.workspaceId,
          user_id,
          namespace: namespaceVal,
          text,
          metadata: metadata ?? {},
        })
        .select("id")
        .single();

      if (memoryError || !memoryInsert) {
        return jsonResponse(
          {
            error: {
              code: "DB_ERROR",
              message: memoryError?.message ?? "Failed to insert memory",
            },
          },
          500,
        );
      }

      const memoryId = memoryInsert.id as string;

      const rows = chunks.map((chunk, idx) => ({
        workspace_id: auth.workspaceId,
        memory_id: memoryId,
        user_id,
        namespace: namespaceVal,
        chunk_index: idx,
        chunk_text: chunk,
        embedding: d.vectorToPgvectorString(embeddings[idx]),
      }));

      const { error: chunkError } = await supabase.from("memory_chunks").insert(rows);
      if (chunkError) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: chunkError.message ?? "Failed to insert chunks" } },
          500,
          rate.headers,
        );
      }

      void d.emitProductEvent(
        supabase,
        "first_ingest_success",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/memories",
          method: "POST",
          status: 200,
          effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
          planStatus: auth.planStatus,
        },
        { body_bytes: Number(request.headers.get("content-length") ?? "0") || undefined },
        true,
      );

      await d.bumpUsage(supabase, auth.workspaceId, today, {
        writesDelta: 1,
        readsDelta: 0,
        embedsDelta: chunkCount,
      });

      return jsonResponse({ memory_id: memoryId, chunks: rows.length }, 200, rate.headers);
    },

    async handleListMemories(request, env, supabase, url, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
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

      const params = d.normalizeMemoryListParams(url);
      const result = await d.performListMemories(auth, params, supabase);

      return jsonResponse(
        {
          results: result.results,
          page: result.page,
          page_size: result.page_size,
          total: result.total,
          has_more: result.has_more,
        },
        200,
        rate.headers,
      );
    },

    async handleGetMemory(request, env, supabase, memoryId, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
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

      const { data, error } = await supabase
        .from("memories")
        .select("id, user_id, namespace, text, metadata, created_at")
        .eq("workspace_id", auth.workspaceId)
        .eq("id", memoryId)
        .maybeSingle();

      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "Failed to fetch memory" } },
          500,
          rate.headers,
        );
      }

      if (!data) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Memory not found" } }, 404, rate.headers);
      }

      return jsonResponse(data, 200, rate.headers);
    },

    async handleDeleteMemory(request, env, supabase, memoryId, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
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

      const deleted = await d.deleteMemoryCascade(supabase, auth.workspaceId, memoryId);
      if (!deleted) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Memory not found" } }, 404, rate.headers);
      }

      return jsonResponse({ deleted: true, id: memoryId }, 200, rate.headers);
    },
  };
}
