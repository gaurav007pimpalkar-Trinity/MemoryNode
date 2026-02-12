import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import {
  DEFAULT_TOPK,
  capsByPlan,
  exceedsCaps,
  MAX_QUERY_CHARS,
  MAX_TEXT_CHARS,
  MAX_TOPK,
  UsageSnapshot,
} from "./limits.js";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { RateLimitDO } from "./rateLimitDO.js";
import { logger, redact } from "./logger.js";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENAI_API_KEY: string;
  API_KEY_SALT: string;
  AUTH_DEBUG?: string;
  MASTER_ADMIN_TOKEN: string;
  EMBEDDINGS_MODE?: string;
  SUPABASE_MODE?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  BUILD_VERSION?: string;
  GIT_SHA?: string;
  RATE_LIMIT_DO: DurableObjectNamespace;
  RATE_LIMIT_MODE?: string;
  ALLOWED_ORIGINS?: string;
  MAX_BODY_BYTES?: string;
  AUDIT_IP_SALT?: string;
  MAX_IMPORT_BYTES?: string;
  MAX_EXPORT_BYTES?: string;
  PAYU_MERCHANT_KEY?: string;
  PAYU_MERCHANT_SALT?: string;
  PAYU_WEBHOOK_SECRET?: string;
  BILLING_RECONCILE_ON_AMBIGUITY?: string;
  BILLING_WEBHOOKS_ENABLED?: string;
  PAYU_BASE_URL?: string;
  PAYU_PRO_AMOUNT?: string;
  PAYU_PRODUCT_INFO?: string;
  PUBLIC_APP_URL?: string;
  PAYU_SUCCESS_PATH?: string;
  PAYU_CANCEL_PATH?: string;
}

interface ApiError {
  code: string;
  message: string;
  status?: number;
  headers?: Record<string, string>;
}

interface AuthContext {
  workspaceId: string;
  keyHash: string;
  plan: "free" | "pro" | "team";
  planStatus?: "free" | "trialing" | "active" | "past_due" | "canceled";
}

interface MemoryInsertPayload {
  user_id: string;
  namespace?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

type MetadataFilter = Record<string, string | number | boolean>;

interface SearchFilters {
  metadata?: MetadataFilter;
  start_time?: string;
  end_time?: string;
}

type PayUWebhookPayload = {
  key?: string;
  txnid?: string;
  mihpayid?: string;
  status?: string;
  hash?: string;
  amount?: string;
  productinfo?: string;
  firstname?: string;
  email?: string;
  udf1?: string;
  udf2?: string;
  addedon?: string;
  [key: string]: unknown;
};

function parseApiKeyMeta(raw: string): { prefix: string; last4: string } {
  const parts = raw.split("_");
  if (parts.length >= 3) {
    return {
      prefix: parts.slice(0, 2).join("_"),
      last4: raw.slice(-4),
    };
  }
  return { prefix: "", last4: raw.slice(-4) };
}

interface SearchPayload {
  user_id: string;
  namespace?: string;
  query: string;
  top_k?: number;
  page?: number;
  page_size?: number;
  filters?: SearchFilters;
}

interface NormalizedSearchParams {
  user_id: string;
  namespace: string;
  query: string;
  top_k: number;
  page: number;
  page_size: number;
  filters: {
    metadata?: MetadataFilter;
    start_time?: string;
    end_time?: string;
  };
}

interface MemoryListParams {
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

const DEFAULT_NAMESPACE = "default";
const SEARCH_MATCH_COUNT = 200;
const MAX_PAGE_SIZE = 50;
const MAX_FUSE_RESULTS = 200;
const DEFAULT_LIST_PAGE_SIZE = 20;
const DEFAULT_MAX_BODY_BYTES = 1_000_000; // 1 MB
const DEFAULT_MAX_IMPORT_BYTES = 10_000_000; // 10 MB
const DEFAULT_MAX_EXPORT_BYTES = 10_000_000; // 10 MB
const MEMORIES_MAX_BODY_BYTES = 1_000_000; // 1 MB for ingest
const SEARCH_MAX_BODY_BYTES = 200_000; // 200 KB for search/context
const ADMIN_MAX_BODY_BYTES = 100_000; // 100 KB for admin/control plane ops
const EXPORT_MAX_BODY_BYTES = 100_000; // exports carry no payload; keep tight
const RRF_K = 60;
const ALLOWED_PLAN_STATUS = new Set(["free", "trialing", "active", "past_due", "canceled"]);
const DEFAULT_SUCCESS_PATH = "/settings/billing?status=success";
const DEFAULT_CANCEL_PATH = "/settings/billing?status=canceled";
const DEFAULT_PAYU_PRO_AMOUNT = "49.00";
const DEFAULT_PAYU_PRODUCT_INFO = "MemoryNode Platform Pro";
const DEFAULT_WEBHOOK_REPROCESS_LIMIT = 50;
let requestCorsHeaders: Record<string, string> = {};
let securityHeaders: Record<string, string> = {};
let requestIdHeaderValue = "";
type ProductEventContext = {
  workspaceId?: string | null;
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  effectivePlan?: AuthContext["plan"];
  planStatus?: AuthContext["planStatus"];
};

function emitEventLog(event_name: string, fields: Record<string, unknown>): void {
  logger.info({
    event: event_name,
    ...fields,
  });
}

async function emitProductEvent(
  supabase: SupabaseClient,
  eventName: string,
  ctx: ProductEventContext,
  props: Record<string, unknown> = {},
  ensureUnique = false,
): Promise<void> {
  try {
    if (!ctx.workspaceId) return;
    if (ensureUnique) {
      const existing = await supabase
        .from("product_events")
        .select("id")
        .eq("workspace_id", ctx.workspaceId)
        .eq("event_name", eventName)
        .limit(1)
        .maybeSingle();
      if (existing.data) return;
    }

    await supabase.from("product_events").insert({
      workspace_id: ctx.workspaceId,
      event_name: eventName,
      request_id: ctx.requestId ?? null,
      route: ctx.route ?? null,
      method: ctx.method ?? null,
      status: ctx.status ?? null,
      effective_plan: ctx.effectivePlan ?? null,
      plan_status: ctx.planStatus ?? null,
      props: props ?? {},
    });
  } catch (err) {
    logger.error({
      event: "product_event_emit_failed",
      event_target: eventName,
      message: redact((err as Error)?.message, "message"),
      err,
    });
  }
}

function effectivePlan(plan: AuthContext["plan"], status?: AuthContext["planStatus"]): AuthContext["plan"] {
  if (status === "active" || status === "trialing") return plan;
  return "free";
}

function normalizePlanStatus(status: unknown): AuthContext["planStatus"] {
  if (typeof status === "string" && ALLOWED_PLAN_STATUS.has(status)) {
    return status as AuthContext["planStatus"];
  }
  if (status !== undefined) {
    logger.error({
      event: "invalid_plan_status",
      plan_status: redact(status, "plan_status"),
    });
  }
  return "free";
}

function assertPayUEnvFor(path: string, env: Env): void {
  const missing: string[] = [];
  if (!env.PAYU_MERCHANT_KEY) missing.push("PAYU_MERCHANT_KEY");
  if (!env.PAYU_MERCHANT_SALT) missing.push("PAYU_MERCHANT_SALT");
  if (!env.PAYU_BASE_URL) missing.push("PAYU_BASE_URL");
  if (!env.PUBLIC_APP_URL) missing.push("PUBLIC_APP_URL");
  if (missing.length) {
    throw createHttpError(500, "CONFIG_ERROR", `Missing PayU configuration: ${missing.join(", ")}`);
  }
}

function isPayUBillingConfigured(env: Env): boolean {
  return Boolean(env.PAYU_MERCHANT_KEY && env.PAYU_MERCHANT_SALT && env.PAYU_BASE_URL && env.PUBLIC_APP_URL);
}

function normalizePayUStatus(status: string | null | undefined): "success" | "pending" | "failure" | "canceled" {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "pending") return "pending";
  if (normalized === "cancel" || normalized === "cancelled" || normalized === "canceled") return "canceled";
  return "failure";
}

function planFromPayUStatus(status: "success" | "pending" | "failure" | "canceled"): AuthContext["plan"] {
  if (status === "success") return "pro";
  return "free";
}

function planStatusFromPayUStatus(status: "success" | "pending" | "failure" | "canceled"): AuthContext["planStatus"] {
  if (status === "success") return "active";
  if (status === "pending") return "past_due";
  if (status === "canceled") return "canceled";
  return "past_due";
}

function normalizeMoneyString(raw: string | undefined): string {
  const parsed = Number(raw ?? DEFAULT_PAYU_PRO_AMOUNT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAYU_PRO_AMOUNT;
  return parsed.toFixed(2);
}

function paymentPeriodEndFromStatus(status: "success" | "pending" | "failure" | "canceled"): string | null {
  if (status !== "success") return null;
  const next = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return next.toISOString();
}

function normalizePayUBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw createHttpError(500, "CONFIG_ERROR", "PAYU_BASE_URL not set");
  const parsed = new URL(trimmed);
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/_payment";
  }
  return parsed.toString();
}

function normalizePayUHash(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

function asNonEmptyString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePayUEventCreated(raw: unknown): number {
  const direct = Number(raw);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  if (typeof raw === "string" && raw.trim().length > 0) {
    const ts = Date.parse(raw);
    if (Number.isFinite(ts) && ts > 0) return Math.floor(ts / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function payUHashReverseSequence(payload: PayUWebhookPayload, env: Env): string {
  return [
    env.PAYU_MERCHANT_SALT!,
    payload.status ?? "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    payload.udf1 ?? "",
    payload.email ?? "",
    payload.firstname ?? "",
    payload.productinfo ?? "",
    payload.amount ?? "",
    payload.txnid ?? "",
    env.PAYU_MERCHANT_KEY!,
  ].join("|");
}

async function computeSha512Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-512", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseWebhookPayload(raw: string, contentType: string): PayUWebhookPayload {
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      return (parsed ?? {}) as PayUWebhookPayload;
    } catch {
      throw createHttpError(400, "BAD_REQUEST", "Webhook body must be valid JSON");
    }
  }
  const params = new URLSearchParams(raw);
  const payload: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    payload[k] = v;
  }
  return payload as PayUWebhookPayload;
}

async function isPayUWebhookSignatureValid(
  payload: PayUWebhookPayload,
  rawBody: string,
  request: Request,
  env: Env,
): Promise<boolean> {
  const received = normalizePayUHash(payload.hash);
  if (!received) return false;

  const merchantKey = asNonEmptyString(payload.key);
  if (merchantKey && merchantKey !== env.PAYU_MERCHANT_KEY) return false;

  const reverse = payUHashReverseSequence(payload, env);
  const expected = normalizePayUHash(await computeSha512Hex(reverse));
  if (expected === received) return true;

  const additionalCharges = asNonEmptyString((payload as { additionalCharges?: unknown }).additionalCharges);
  if (additionalCharges) {
    const expectedWithCharges = normalizePayUHash(await computeSha512Hex(`${additionalCharges}|${reverse}`));
    if (expectedWithCharges === received) return true;
  }

  const webhookSecret = asNonEmptyString(env.PAYU_WEBHOOK_SECRET);
  const signatureHeader = asNonEmptyString(request.headers.get("x-payu-signature"));
  if (webhookSecret && signatureHeader) {
    const fallback = normalizePayUHash(await computeSha512Hex(`${rawBody}|${webhookSecret}`));
    return fallback === normalizePayUHash(signatureHeader);
  }

  return false;
}

function buildUpgradeUrl(env: Env): string {
  if (env.PUBLIC_APP_URL) {
    try {
      return new URL("/settings/billing", env.PUBLIC_APP_URL).toString();
    } catch {
      /* ignore invalid URL */
    }
  }
  return "/settings/billing";
}

async function shortHash(value: string, length = 12): Promise<string> {
  const full = await sha256Hex(value);
  return full.slice(0, length);
}

function capExceededResponse(
  auth: AuthContext,
  caps: UsageSnapshot,
  usage: UsageSnapshot,
  rateHeaders: Record<string, string> | undefined,
  env: Env,
  logCtx?: { requestId?: string; route?: string; method?: string },
): Response {
  emitEventLog("cap_exceeded", {
    route: logCtx?.route ?? "",
    method: logCtx?.method ?? "",
    status: 402,
    request_id: logCtx?.requestId ?? "",
    workspace_id_redacted: redact(auth.workspaceId, "workspace_id"),
    effective_plan: effectivePlan(auth.plan, auth.planStatus),
    plan_status: auth.planStatus ?? "free",
  });
  return jsonResponse(
    {
      error: {
        code: "CAP_EXCEEDED",
        message: "Daily usage limits exceeded",
        upgrade_required: true,
        effective_plan: effectivePlan(auth.plan, auth.planStatus),
        limits: caps,
        usage,
        upgrade_url: buildUpgradeUrl(env),
      },
    },
    402,
    rateHeaders,
  );
}

async function checkCapsAndMaybeRespond(
  auth: AuthContext,
  supabase: SupabaseClient,
  deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
  rateHeaders: Record<string, string> | undefined,
  env: Env,
  logCtx?: { requestId?: string; route?: string; method?: string },
): Promise<Response | null> {
  const today = todayUtc();
  const usage = await getUsage(supabase, auth.workspaceId, today);
  const caps = capsByPlan[effectivePlan(auth.plan, auth.planStatus)] ?? capsByPlan.free;
  const tooMuch = exceedsCaps(caps, usage as UsageSnapshot, deltas);
  if (tooMuch) {
    void emitProductEvent(
      supabase,
      "cap_exceeded",
      {
        workspaceId: auth.workspaceId,
        requestId: logCtx?.requestId,
        route: logCtx?.route,
        method: logCtx?.method,
        status: 402,
        effectivePlan: effectivePlan(auth.plan, auth.planStatus),
        planStatus: auth.planStatus,
      },
      {},
    );
    return capExceededResponse(auth, caps, usage as UsageSnapshot, rateHeaders, env, logCtx);
  }
  return null;
}

const setCorsHeadersForRequest = (headers: Record<string, string>) => {
  requestCorsHeaders = headers;
};
const clearCorsHeadersForRequest = () => {
  requestCorsHeaders = {};
};
const getCorsHeaders = () => requestCorsHeaders;
const setSecurityHeadersForRequest = (path: string) => {
  securityHeaders = buildSecurityHeaders(path);
};
const clearSecurityHeadersForRequest = () => {
  securityHeaders = {};
};
const getSecurityHeaders = () => securityHeaders;
const setRequestIdForRequest = (requestId: string) => {
  requestIdHeaderValue = requestId;
};
const clearRequestIdForRequest = () => {
  requestIdHeaderValue = "";
};
const getRequestIdHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (requestIdHeaderValue) {
    headers["x-request-id"] = requestIdHeaderValue;
  }
  return headers;
};

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function generateRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function resolveRequestId(request: Request): string {
  const incoming = (request.headers.get("x-request-id") ?? "").trim();
  if (incoming && REQUEST_ID_RE.test(incoming)) {
    return incoming;
  }
  return generateRequestId();
}

function attachRequestIdToErrorPayload(data: unknown, status: number): unknown {
  if (status < 400) return data;
  if (!requestIdHeaderValue) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const payload = data as Record<string, unknown>;
  if (!("error" in payload)) return data;
  if (typeof payload.request_id === "string" && payload.request_id.length > 0) return data;
  return { ...payload, request_id: requestIdHeaderValue };
}

const jsonResponse = (
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response => {
  const body = attachRequestIdToErrorPayload(data, status);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...getCorsHeaders(),
      ...getSecurityHeaders(),
      ...getRequestIdHeaders(),
      ...(extraHeaders ?? {}),
    },
  });
};

const emptyResponse = (status = 204): Response =>
  new Response(null, { status, headers: { ...getCorsHeaders(), ...getSecurityHeaders(), ...getRequestIdHeaders() } });

type ErrorLogFields = {
  error_code?: string;
  error_message?: string;
};

async function extractErrorLogFields(response: Response | null): Promise<ErrorLogFields> {
  if (!response || response.status < 400) return {};
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return {};
  try {
    const payload = (await response.clone().json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    const code = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
    const message = typeof payload?.error?.message === "string" ? payload.error.message : undefined;
    return {
      ...(code ? { error_code: code } : {}),
      ...(message ? { error_message: redact(message, "message") as string } : {}),
    };
  } catch {
    return {};
  }
}

function ensureRateLimitDo(env: Env): void {
  const ns = env.RATE_LIMIT_DO as unknown as { idFromName?: unknown; get?: unknown };
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    throw createHttpError(
      500,
      "CONFIG_ERROR",
      "Missing Durable Object binding RATE_LIMIT_DO. Check wrangler.toml durable_objects binding name.",
    );
  }
}

function isProductionStage(env: Env): boolean {
  const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "").trim().toLowerCase();
  return stage === "prod" || stage === "production";
}

function enforceRuntimeConfigGuards(env: Env): void {
  if (!isProductionStage(env)) return;
  const supabaseMode = (env.SUPABASE_MODE ?? "").trim().toLowerCase();
  if (supabaseMode === "stub") {
    throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_MODE=stub is forbidden in production");
  }
  const embeddingsMode = (env.EMBEDDINGS_MODE ?? "openai").trim().toLowerCase();
  if (embeddingsMode === "stub") {
    throw createHttpError(500, "CONFIG_ERROR", "EMBEDDINGS_MODE=stub is forbidden in production");
  }
  const rateLimitMode = (env.RATE_LIMIT_MODE ?? "on").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(rateLimitMode)) {
    throw createHttpError(500, "CONFIG_ERROR", "RATE_LIMIT_MODE=off is forbidden in production");
  }
}

function resolveBodyLimit(method: string, path: string, env: Env): number {
  const base = Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  if (method === "POST" && path === "/v1/memories") return Math.min(base, MEMORIES_MAX_BODY_BYTES);
  if (method === "POST" && (path === "/v1/search" || path === "/v1/context"))
    return Math.min(base, SEARCH_MAX_BODY_BYTES);
  if (method === "POST" && path === "/v1/export")
    return Math.min(Number(env.MAX_EXPORT_BYTES ?? DEFAULT_MAX_EXPORT_BYTES), EXPORT_MAX_BODY_BYTES);
  if (method === "POST" && path === "/v1/import") return Number(env.MAX_IMPORT_BYTES ?? DEFAULT_MAX_IMPORT_BYTES);
  if (method === "POST" && (path === "/v1/workspaces" || path === "/v1/api-keys" || path === "/v1/api-keys/revoke"))
    return Math.min(base, ADMIN_MAX_BODY_BYTES);
  return base;
}

function buildSecurityHeaders(path: string): Record<string, string> {
  const base: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
  };
  const sensitive =
    path.startsWith("/v1/api-keys") ||
    path.startsWith("/v1/workspaces") ||
    path.startsWith("/v1/usage") ||
    path.startsWith("/v1/import") ||
    path.startsWith("/v1/export");

  base["cache-control"] = sensitive ? "no-store" : "private, no-cache, must-revalidate";
  return base;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const requestId = resolveRequestId(request);
    setRequestIdForRequest(requestId);
    const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
    const origin = request.headers.get("origin") ?? "";
    const allowlist = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const originAllowed = isOriginAllowed(origin, allowlist);
    const cors = makeCorsHeaders(origin, allowlist, request.headers);
    setCorsHeadersForRequest(cors);
    const url = new URL(request.url);
    setSecurityHeadersForRequest(url.pathname);
    let supabase: SupabaseClient | null = null;
    const auditCtx: { workspaceId?: string; apiKeyId?: string } = {};
    let response: Response | null = null;
    try {
      if (allowlist && !originAllowed) {
        response = jsonResponse({ error: { code: "CORS_DENY", message: "Origin not allowed" } }, 403);
        return response;
      }

      enforceRuntimeConfigGuards(env);
      ensureRateLimitDo(env);

      if (request.method === "OPTIONS") {
        response = emptyResponse();
        return response;
      }

      const bodyLimit = resolveBodyLimit(request.method, url.pathname, env);
      await assertBodySize(request, env, bodyLimit);

      if (request.method === "GET" && url.pathname === "/healthz") {
        const buildVersion = (env.BUILD_VERSION ?? "").trim();
        const version = buildVersion || "dev";
        const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "").trim();
        const gitSha = (env.GIT_SHA ?? "").trim();
        response = jsonResponse({
          status: "ok",
          version,
          build_version: version,
          ...(gitSha ? { git_sha: gitSha } : {}),
          ...(stage ? { stage } : {}),
        });
        return response;
      }

      supabase = createSupabaseClient(env);

      if (request.method === "POST" && url.pathname === "/v1/memories") {
        response = await handleCreateMemory(request, env, supabase, auditCtx, requestId);
        return response;
      }

      if (request.method === "GET" && url.pathname === "/v1/memories") {
        response = await handleListMemories(request, env, supabase, url, auditCtx);
        return response;
      }

      const memoryIdMatch = url.pathname.match(/^\/v1\/memories\/([^/]+)$/);
      if (memoryIdMatch) {
        const rawMemoryId = decodeURIComponent(memoryIdMatch[1]);
        const memoryId = rawMemoryId.split("?")[0].split("#")[0].trim();
        if (memoryId.startsWith("=") || !UUID_RE.test(memoryId)) {
          response = jsonResponse(
            { error: { code: "BAD_REQUEST", message: "memory_id must be a valid UUID" } },
            400,
          );
          return response;
        }
        if (request.method === "GET") {
          response = await handleGetMemory(request, env, supabase, memoryId, auditCtx);
          return response;
        }
        if (request.method === "DELETE") {
          response = await handleDeleteMemory(request, env, supabase, memoryId, auditCtx);
          return response;
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/search") {
        response = await handleSearch(request, env, supabase, auditCtx, requestId);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/context") {
        response = await handleContext(request, env, supabase, auditCtx, requestId);
        return response;
      }

      if (request.method === "GET" && url.pathname === "/v1/usage/today") {
        response = await handleUsageToday(request, env, supabase, auditCtx);
        return response;
      }

      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        response = await handleBillingStatus(request, env, supabase, auditCtx, requestId);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/billing/checkout") {
        response = await handleBillingCheckout(request, env, supabase, auditCtx, requestId);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/billing/portal") {
        response = await handleBillingPortal(request, env, supabase, auditCtx, requestId);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/billing/webhook") {
        response = await handleBillingWebhook(request, env, supabase, requestId);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces") {
        response = await handleCreateWorkspace(request, env, supabase);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/api-keys") {
        response = await handleCreateApiKey(request, env, supabase);
        return response;
      }

      if (request.method === "GET" && url.pathname === "/v1/api-keys") {
        response = await handleListApiKeys(request, env, supabase);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/api-keys/revoke") {
        response = await handleRevokeApiKey(request, env, supabase);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/admin/webhooks/reprocess") {
        response = await handleReprocessDeferredWebhooks(request, env, supabase, requestId);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/export") {
        response = await handleExport(request, env, supabase, auditCtx);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/import") {
        response = await handleImport(request, env, supabase, auditCtx);
        return response;
      }

      response = jsonResponse({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      return response;
    } catch (error: unknown) {
      const status = isApiError(error) ? error.status ?? 500 : 500;
      const errorCode = isApiError(error) ? error.code : "INTERNAL";
      const safeMessage = redact((error as Error)?.message, "message");
      logger.error({
        event: "request_failed",
        request_id: requestId,
        route: url.pathname,
        method: request.method,
        status,
        error_code: errorCode,
        error_message: safeMessage,
        workspace_id: auditCtx.workspaceId ?? null,
        err: error,
      });
      if (isApiError(error)) {
        response = jsonResponse(
          { error: { code: error.code, message: error.message } },
          error.status ?? 500,
          error.headers,
        );
        return response;
      }
      response = jsonResponse(
        { error: { code: "INTERNAL", message: "Unexpected error occurred" } },
        500,
      );
      return response;
    } finally {
      try {
        await emitAuditLog(request, response, started, ip, env, supabase, auditCtx, requestId);
        const durationMs = Date.now() - started;
        const errorFields = await extractErrorLogFields(response);
        logger.info({
          event: "request_completed",
          workspace_id: auditCtx.workspaceId ?? null,
          route: url.pathname,
          method: request.method,
          status: response?.status ?? 0,
          duration_ms: durationMs,
          latency_ms: durationMs,
          request_id: requestId,
          ...errorFields,
        });
      } finally {
        clearRequestIdForRequest();
        clearCorsHeadersForRequest();
        clearSecurityHeadersForRequest();
      }
    }
  },
  RateLimitDO,
};

export { RateLimitDO, createSupabaseClient };

function createSupabaseClient(env: Env): SupabaseClient {
  const supabaseMode = (env.SUPABASE_MODE ?? "").toLowerCase();
  if (supabaseMode === "stub") {
    if (isProductionStage(env)) {
      throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_MODE=stub is forbidden in production");
    }
    return createStubSupabase(env) as unknown as SupabaseClient;
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw createHttpError(500, "CONFIG_ERROR", "Supabase env vars not set");
  }

  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

type StubRow = Record<string, unknown>;
type StubFilter = { col: string; val: unknown; op: "eq" | "in" | "contains" | "gte" | "lte" };

let stubState: {
  db: {
    workspaces: StubRow[];
    api_keys: StubRow[];
    memories: StubRow[];
    memory_chunks: StubRow[];
    usage_daily: StubRow[];
    api_audit_log: StubRow[];
    app_settings: StubRow[];
    product_events: StubRow[];
    payu_webhook_events: StubRow[];
  };
  rawApiKeys: Map<string, { workspaceId: string }>;
} | null = null;

function createStubSupabase(env: Env) {
  if (!stubState) {
    stubState = {
      db: {
        workspaces: [] as StubRow[],
        api_keys: [] as StubRow[],
        memories: [] as StubRow[],
        memory_chunks: [] as StubRow[],
        usage_daily: [] as StubRow[],
        api_audit_log: [] as StubRow[],
        app_settings: [{ api_key_salt: env.API_KEY_SALT ?? "" }],
        product_events: [] as StubRow[],
        payu_webhook_events: [] as StubRow[],
      },
      rawApiKeys: new Map<string, { workspaceId: string }>(),
    };
  }
  const { db, rawApiKeys } = stubState;

  const applyFilters = (rows: StubRow[], filters: StubFilter[]) =>
    rows.filter((r) =>
      filters.every((f) => {
        if (f.op === "contains") {
          const target = r[f.col] as Record<string, unknown>;
          return (
            typeof target === "object" &&
            target !== null &&
            Object.entries(f.val as Record<string, unknown>).every(([k, v]) => target[k] === v)
          );
        }
        if (f.op === "in") {
          const values = Array.isArray(f.val) ? f.val : [];
          return values.includes(r[f.col]);
        }
        if (f.op === "gte") return (r[f.col] as string) >= (f.val as string);
        if (f.op === "lte") return (r[f.col] as string) <= (f.val as string);
        return r[f.col] === f.val;
      }),
    );

  const makeResult = (rows: StubRow[], count?: number) => ({
    data: rows,
    error: null,
    count,
    limit() {
      return this;
    },
    eq(col: string, val: unknown) {
      return makeResult(
        rows.filter((r) => r[col] === val),
        count ? rows.filter((r) => r[col] === val).length : undefined,
      );
    },
    is(col: string, val: unknown) {
      return this.eq(col, val);
    },
    contains(obj: Record<string, unknown>) {
      const filtered = rows.filter((r) => {
        const target = r.metadata as Record<string, unknown>;
        return typeof target === "object" && target !== null && Object.entries(obj).every(([k, v]) => target[k] === v);
      });
      return makeResult(filtered, count ? filtered.length : undefined);
    },
    order() {
      return this;
    },
    range() {
      return this;
    },
    maybeSingle() {
      return { data: rows[0] ?? null, error: null };
    },
    single() {
      return { data: rows[0] ?? null, error: null };
    },
  });

  const tableBuilder = (table: keyof typeof db, filters: StubFilter[] = []) => ({
    eq(col: string, val: unknown) {
      filters.push({ col, val, op: "eq" });
      return tableBuilder(table, filters);
    },
    in(col: string, vals: unknown[]) {
      filters.push({ col, val: [...vals], op: "in" });
      return tableBuilder(table, filters);
    },
    contains(obj: Record<string, unknown>) {
      filters.push({ col: "metadata", val: obj, op: "contains" });
      return tableBuilder(table, filters);
    },
    gte(col: string, val: unknown) {
      filters.push({ col, val, op: "gte" });
      return tableBuilder(table, filters);
    },
    lte(col: string, val: unknown) {
      filters.push({ col, val, op: "lte" });
      return tableBuilder(table, filters);
    },
    select(_cols?: string, opts?: { count?: "exact" }) {
      const rows = applyFilters(db[table], filters);
      return makeResult(rows, opts?.count ? rows.length : undefined);
    },
    limit(_n: number) {
      void _n;
      return this;
    },
    insert(payload: StubRow | StubRow[]) {
      const rows = Array.isArray(payload) ? payload : [payload];
      rows.forEach((r) => {
        if (table === "api_keys" && !Object.prototype.hasOwnProperty.call(r, "revoked_at")) {
          (r as Record<string, unknown>).revoked_at = null;
        }
        if (!r.id) (r as Record<string, unknown>).id = crypto.randomUUID();
        db[table].push(structuredClone(r));
      });
      return {
        select(_sel?: string) {
          void _sel;
          return {
            single: async () => ({ data: rows[0], error: null }),
            maybeSingle: async () => ({ data: rows[0], error: null }),
          };
        },
        single: async () => ({ data: rows[0], error: null }),
        maybeSingle: async () => ({ data: rows[0], error: null }),
        error: null,
        data: rows,
      };
    },
    update(values: Record<string, unknown>) {
      return {
        eq(col: string, val: unknown) {
          const rows = applyFilters(db[table], filters.concat({ col, val, op: "eq" }));
          rows.forEach((r) => Object.assign(r, values));
          return { data: rows, error: null };
        },
      };
    },
    delete(opts?: { count?: "exact" }) {
      const deleteFilters = [...filters];
      let executed = false;
      let result: { data: never[]; error: null; count: number | null } = {
        data: [],
        error: null,
        count: null,
      };
      const runDelete = () => {
        if (executed) return result;
        const rows = applyFilters(db[table], deleteFilters);
        db[table] = db[table].filter((r) => !rows.includes(r));
        executed = true;
        result = { data: [], error: null, count: opts?.count ? rows.length : null };
        return result;
      };
      const chain = {
        eq(col: string, val: unknown) {
          deleteFilters.push({ col, val, op: "eq" });
          return chain;
        },
        in(col: string, vals: unknown[]) {
          deleteFilters.push({ col, val: [...vals], op: "in" });
          return chain;
        },
        then<TResult1 = typeof result, TResult2 = never>(
          onfulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(runDelete()).then(onfulfilled, onrejected);
        },
      };
      return chain;
    },
    order() {
      return this;
    },
    range(from?: number, to?: number) {
      if (from !== undefined && to !== undefined) {
        const rows = applyFilters(db[table], filters).slice(from, to + 1);
        return makeResult(rows);
      }
      return this;
    },
  });

  return {
    from(table: string) {
      return tableBuilder(table as keyof typeof db);
    },
    rpc(name: string, params: Record<string, unknown>) {
      switch (name) {
        case "bump_usage":
        case "bump_usage_rpc": {
          const existing = db.usage_daily.find(
            (r) => r.workspace_id === params.p_workspace_id && r.day === params.p_day,
          );
          if (existing) {
            existing.writes = (existing.writes as number) + (params.p_writes as number);
            existing.reads = (existing.reads as number) + (params.p_reads as number);
            existing.embeds = (existing.embeds as number) + (params.p_embeds as number);
            return Promise.resolve({ data: existing, error: null });
          }
          const row = {
            workspace_id: params.p_workspace_id,
            day: params.p_day,
            writes: params.p_writes,
            reads: params.p_reads,
            embeds: params.p_embeds,
          };
          db.usage_daily.push(row);
          return Promise.resolve({ data: row, error: null });
        }
        case "match_chunks_vector":
        case "match_chunks_text": {
          const chunks = db.memory_chunks.filter(
            (c) =>
              c.workspace_id === params.p_workspace_id &&
              c.user_id === params.p_user_id &&
              c.namespace === params.p_namespace,
          );
          const q = (params.p_query as string | undefined)?.toLowerCase() ?? "";
          const results = chunks
            .filter((c) => (c.chunk_text as string).toLowerCase().includes(q))
            .slice(0, Number(params.p_match_count ?? 20))
            .map((c, idx) => ({
              chunk_id: c.id as string,
              memory_id: c.memory_id as string,
              chunk_index: c.chunk_index as number,
              chunk_text: c.chunk_text as string,
              score: 1 / (idx + 1),
            }));
          return Promise.resolve({ data: results, error: null });
        }
        default:
          return Promise.resolve({ data: null, error: null });
      }
    },
    __rawApiKeys: rawApiKeys,
    __db: db,
  };
}

async function handleCreateMemory(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
  requestId = "",
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  auditCtx.workspaceId = auth.workspaceId;
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const parseResult = await safeParseJson<MemoryInsertPayload>(request);
  if (!parseResult.ok) {
    return jsonResponse({ error: { code: "BAD_REQUEST", message: parseResult.error } }, 400);
  }

  const { user_id, text, metadata, namespace = DEFAULT_NAMESPACE } = parseResult.data;

  if (!user_id || !text) {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: "user_id and text are required" } },
      400,
    );
  }

  if (text.length > MAX_TEXT_CHARS) {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: `text exceeds ${MAX_TEXT_CHARS} chars` } },
      400,
    );
  }

  const chunks = chunkText(text);
  const chunkCount = chunks.length;

  const capResponse = await checkCapsAndMaybeRespond(
    auth,
    supabase,
    { writesDelta: 1, readsDelta: 0, embedsDelta: chunkCount },
    rate.headers,
    env,
    { requestId, route: "/v1/memories", method: "POST" },
  );
  if (capResponse) return capResponse;

  const today = todayUtc();
  const embeddings = await embedText(chunks, env);

  const { data: memoryInsert, error: memoryError } = await supabase
    .from("memories")
    .insert({
      workspace_id: auth.workspaceId,
      user_id,
      namespace,
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
    namespace,
    chunk_index: idx,
    chunk_text: chunk,
    embedding: vectorToPgvectorString(embeddings[idx]),
  }));

  const { error: chunkError } = await supabase.from("memory_chunks").insert(rows);
  if (chunkError) {
    return jsonResponse(
      { error: { code: "DB_ERROR", message: chunkError.message ?? "Failed to insert chunks" } },
      500,
      rate.headers,
    );
  }

  void emitProductEvent(
    supabase,
    "first_ingest_success",
    {
      workspaceId: auth.workspaceId,
      requestId,
      route: "/v1/memories",
      method: "POST",
      status: 200,
      effectivePlan: effectivePlan(auth.plan, auth.planStatus),
      planStatus: auth.planStatus,
    },
    { body_bytes: Number(request.headers.get("content-length") ?? "0") || undefined },
    true,
  );

  await bumpUsage(supabase, auth.workspaceId, today, {
    writesDelta: 1,
    readsDelta: 0,
    embedsDelta: chunkCount,
  });

  return jsonResponse({ memory_id: memoryId, chunks: rows.length }, 200, rate.headers);
}

async function handleListMemories(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  url: URL,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const params = normalizeMemoryListParams(url);
  const result = await performListMemories(auth, params, supabase);

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
}

async function handleGetMemory(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  memoryId: string,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
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
}

async function handleDeleteMemory(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  memoryId: string,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const deleted = await deleteMemoryCascade(supabase, auth.workspaceId, memoryId);
  if (!deleted) {
    return jsonResponse({ error: { code: "NOT_FOUND", message: "Memory not found" } }, 404, rate.headers);
  }

  return jsonResponse({ deleted: true, id: memoryId }, 200, rate.headers);
}

async function handleSearch(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
  requestId = "",
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }
  const parseResult = await safeParseJson<SearchPayload>(request);
  if (!parseResult.ok) {
    return jsonResponse({ error: { code: "BAD_REQUEST", message: parseResult.error } }, 400, rate.headers);
  }

  const capResponse = await checkCapsAndMaybeRespond(
    auth,
    supabase,
    { writesDelta: 0, readsDelta: 1, embedsDelta: 1 },
    rate.headers,
    env,
    { requestId, route: "/v1/search", method: "POST" },
  );
  if (capResponse) return capResponse;

  const outcome = await performSearch(auth, parseResult.data, env, supabase);

  void emitProductEvent(
    supabase,
    "first_search_success",
    {
      workspaceId: auth.workspaceId,
      requestId,
      route: "/v1/search",
      method: "POST",
      status: 200,
      effectivePlan: effectivePlan(auth.plan, auth.planStatus),
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
}

async function handleContext(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
  requestId = "",
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }
  const parseResult = await safeParseJson<SearchPayload>(request);
  if (!parseResult.ok) {
    return jsonResponse({ error: { code: "BAD_REQUEST", message: parseResult.error } }, 400, rate.headers);
  }

  const capResponse = await checkCapsAndMaybeRespond(
    auth,
    supabase,
    { writesDelta: 0, readsDelta: 1, embedsDelta: 1 },
    rate.headers,
    env,
    { requestId, route: "/v1/context", method: "POST" },
  );
  if (capResponse) return capResponse;

  const outcome = await performSearch(auth, parseResult.data, env, supabase);
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

  void emitProductEvent(
    supabase,
    "first_context_success",
    {
      workspaceId: auth.workspaceId,
      requestId,
      route: "/v1/context",
      method: "POST",
      status: 200,
      effectivePlan: effectivePlan(auth.plan, auth.planStatus),
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
}

async function authenticate(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx?: { workspaceId?: string; apiKeyId?: string },
): Promise<AuthContext> {
  const rawKey = extractApiKey(request);
  if (!rawKey) {
    throw createHttpError(401, "UNAUTHORIZED", "Missing API key");
  }

  const stubKeys = (supabase as unknown as { __rawApiKeys?: Map<string, { workspaceId: string }>; __db?: Record<string, StubRow[]> }).__rawApiKeys;
  if (env.SUPABASE_URL === "stub" && stubKeys && stubKeys.has(rawKey)) {
    const workspaceId = stubKeys.get(rawKey)!.workspaceId;
    const db = (supabase as unknown as { __db?: Record<string, StubRow[]> }).__db;
    const wsRow = db?.workspaces?.find?.((w) => w.id === workspaceId);
    const planRaw = (wsRow?.plan as string) ?? "free";
    const planStatus = normalizePlanStatus(wsRow?.plan_status ?? "active") ?? "active";
    return { workspaceId, keyHash: rawKey, plan: planRaw === "team" ? "team" : planRaw === "pro" ? "pro" : "free", planStatus };
  }

  const saltOutcome = await getApiKeySalt(env, supabase);
  if (saltOutcome.mismatchFatal) {
    throw createHttpError(500, "CONFIG_ERROR", "API key salt mismatch between env and database");
  }
  const hashed = await hashApiKey(rawKey, saltOutcome.salt);
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, workspace_id, workspaces(plan, plan_status)")
    .eq("key_hash", hashed)
    .is("revoked_at", null)
    .single();
  const authMatched = !error && Boolean(data?.workspace_id);
  if ((env.AUTH_DEBUG ?? "").trim() === "1") {
    const errorCode = typeof (error as { code?: unknown } | null)?.code === "string"
      ? (error as { code: string }).code
      : undefined;
    console.info("auth_debug_verify", {
      hash_prefix: hashed.slice(0, 12),
      matched: authMatched,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }

  if (!authMatched) {
    throw createHttpError(401, "UNAUTHORIZED", "Invalid API key");
  }

  const workspace = (data as unknown as { workspaces?: { plan?: string; plan_status?: AuthContext["planStatus"] } })
    .workspaces;
  const planRaw = workspace?.plan;
  const planStatusRaw = normalizePlanStatus(workspace?.plan_status);
  const plan: AuthContext["plan"] = planRaw === "pro" || planRaw === "team" ? planRaw : "free";

  const ctx: AuthContext = {
    workspaceId: data.workspace_id as string,
    keyHash: hashed,
    plan,
    planStatus: planStatusRaw ?? "free",
  };
  if (auditCtx) {
    auditCtx.workspaceId = ctx.workspaceId;
    auditCtx.apiKeyId = (data as { id?: string }).id;
  }
  return ctx;
}

function extractApiKey(request: Request): string | null {
  const headerKey = request.headers.get("x-api-key");
  if (headerKey) return headerKey.trim();

  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  return null;
}

async function safeParseJson<T>(request: Request): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = (await request.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseIsoTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError(400, "BAD_REQUEST", "Invalid ISO timestamp for time filter");
  }
  return parsed.toISOString();
}

function cleanMetadataFilter(raw?: Record<string, unknown> | MetadataFilter): MetadataFilter | undefined {
  if (!raw) return undefined;
  const cleaned: MetadataFilter = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === null || typeof val === "undefined") continue;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      cleaned[key] = val;
    } else {
      throw createHttpError(400, "BAD_REQUEST", "Metadata filter values must be primitives");
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function normalizeSearchPayload(payload: SearchPayload): NormalizedSearchParams {
  const { user_id, query } = payload;
  if (!user_id || !query) {
    throw createHttpError(400, "BAD_REQUEST", "user_id and query are required");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw createHttpError(400, "BAD_REQUEST", `query exceeds ${MAX_QUERY_CHARS} chars`);
  }

  const namespace = (payload.namespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  const top_k = clamp(payload.top_k ?? DEFAULT_TOPK, 1, MAX_TOPK);
  const page = clamp(payload.page ?? 1, 1, Number.MAX_SAFE_INTEGER);
  const page_size = clamp(payload.page_size ?? top_k, 1, MAX_PAGE_SIZE);

  const metadata = cleanMetadataFilter(payload.filters?.metadata);
  const start_time = parseIsoTimestamp(payload.filters?.start_time);
  const end_time = parseIsoTimestamp(payload.filters?.end_time);
  if (start_time && end_time && new Date(start_time) > new Date(end_time)) {
    throw createHttpError(400, "BAD_REQUEST", "start_time must be before or equal to end_time");
  }

  return {
    user_id,
    query,
    namespace,
    top_k,
    page,
    page_size,
    filters: {
      metadata,
      start_time,
      end_time,
    },
  };
}

export function normalizeMemoryListParams(url: URL): MemoryListParams {
  const page = clamp(Number(url.searchParams.get("page") ?? 1), 1, Number.MAX_SAFE_INTEGER);
  const page_size = clamp(
    Number(url.searchParams.get("page_size") ?? DEFAULT_LIST_PAGE_SIZE),
    1,
    MAX_PAGE_SIZE,
  );
  const namespace = url.searchParams.get("namespace") ?? undefined;
  const user_id = url.searchParams.get("user_id") ?? undefined;

  let metadata: MetadataFilter | undefined;
  const metadataRaw = url.searchParams.get("metadata");
  if (metadataRaw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(metadataRaw)) as Record<string, unknown>;
      metadata = cleanMetadataFilter(parsed);
    } catch {
      throw createHttpError(400, "BAD_REQUEST", "metadata must be valid JSON object");
    }
  }

  const start_time = parseIsoTimestamp(url.searchParams.get("start_time") ?? undefined);
  const end_time = parseIsoTimestamp(url.searchParams.get("end_time") ?? undefined);
  if (start_time && end_time && new Date(start_time) > new Date(end_time)) {
    throw createHttpError(400, "BAD_REQUEST", "start_time must be before or equal to end_time");
  }

  return {
    page,
    page_size,
    namespace: namespace || undefined,
    user_id: user_id || undefined,
    filters: { metadata, start_time, end_time },
  };
}

export function parseAllowedOrigins(raw?: string): string[] | null {
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

export function isOriginAllowed(origin: string, allowlist: string[] | null): boolean {
  if (!allowlist) return true;
  if (!origin) return false;
  if (allowlist.includes("*")) return true;
  return allowlist.some((allowed) => allowed === origin);
}

export function makeCorsHeaders(
  origin: string,
  allowlist: string[] | null,
  requestHeaders?: Headers,
): Record<string, string> {
  if (!allowlist) return {};
  const requestedHeaders = requestHeaders?.get("access-control-request-headers");
  const base = {
    vary: "Origin",
    "access-control-allow-headers": requestedHeaders ?? "authorization,content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS,DELETE",
    "access-control-max-age": "600",
  };
  if (allowlist.includes("*")) {
    return { ...base, "access-control-allow-origin": "*" };
  }
  if (allowlist.includes(origin)) {
    return { ...base, "access-control-allow-origin": origin };
  }
  return {};
}

export async function assertBodySize(request: Request, env: Env, overrideLimit?: number): Promise<void> {
  const limit = overrideLimit ?? Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > limit) {
    throw createHttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
  }
  if (request.body) {
    const clone = request.clone();
    const reader = clone.body!.getReader();
    let received = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.length ?? 0;
      if (received > limit) {
        throw createHttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
      }
    }
  }
}

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function emitAuditLog(
  request: Request,
  response: Response | null,
  started: number,
  ip: string,
  env: Env,
  supabase: SupabaseClient | null,
  ctx: { workspaceId?: string; apiKeyId?: string },
  requestId: string,
): Promise<void> {
  try {
    const latency = Date.now() - started;
    const origin = request.headers.get("origin") ?? "";
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    const route = new URL(request.url).pathname;
    const ipHash = await hashIp(ip + (env.AUDIT_IP_SALT ?? ""));
    const bytesOut = Number(response?.headers.get("content-length") ?? "0");
    const status = response?.status ?? 0;
    const record = {
      ts: new Date().toISOString(),
      route,
      method: request.method,
      origin,
      bytes_in: Number.isFinite(contentLength) ? contentLength : 0,
      bytes_out: Number.isFinite(bytesOut) ? bytesOut : 0,
      latency_ms: latency,
      workspace_id: ctx.workspaceId ?? null,
      api_key_id: ctx.apiKeyId ?? null,
      ip_hash: ipHash,
      status,
      user_agent: request.headers.get("user-agent") ?? null,
      request_id: requestId,
    };
    logger.info({
      event: "audit_log",
      request_id: requestId,
      audit: record,
    });
    if (supabase) {
      await supabase.from("api_audit_log").insert({
        workspace_id: record.workspace_id,
        api_key_id: record.api_key_id,
        route: record.route,
        method: record.method,
        status: record.status,
        bytes_in: record.bytes_in,
        bytes_out: record.bytes_out,
        latency_ms: record.latency_ms,
        ip_hash: record.ip_hash,
        user_agent: record.user_agent,
      });
    }
  } catch (err) {
    logger.error({
      event: "audit_log_failed",
      request_id: requestId,
      route: new URL(request.url).pathname,
      method: request.method,
      err,
    });
  }
}

function b64encode(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  const btoaFn = (globalThis as { btoa?: typeof btoa }).btoa as typeof btoa;
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoaFn(binary);
}

function b64decode(input: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(input, "base64"));
  }
  const atobFn = (globalThis as { atob?: typeof atob }).atob as typeof atob;
  const binary = atobFn(input);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ExportManifest = {
  version: 1;
  workspace_id: string;
  generated_at: string;
  files: Array<{ name: string; sha256: string; size: number }>;
  counts: { memories: number; chunks: number };
};

export async function buildExportArtifact(
  auth: AuthContext,
  supabase: SupabaseClient,
  maxBytes = DEFAULT_MAX_EXPORT_BYTES,
): Promise<ExportOutcome> {
  const memRes = await supabase
    .from("memories")
    .select("id, user_id, namespace, text, metadata, created_at", { count: "exact" })
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (memRes.error) throw createHttpError(500, "DB_ERROR", memRes.error.message ?? "Failed to export memories");

  const chunkRes = await supabase
    .from("memory_chunks")
    .select("id, memory_id, user_id, namespace, chunk_index, chunk_text, embedding, created_at", { count: "exact" })
    .eq("workspace_id", auth.workspaceId)
    .order("memory_id")
    .order("chunk_index");
  if (chunkRes.error)
    throw createHttpError(500, "DB_ERROR", chunkRes.error.message ?? "Failed to export memory chunks");

  const memories = memRes.data ?? [];
  const chunks = chunkRes.data ?? [];

  const memNdjson = memories.map((m) => JSON.stringify(m)).join("\n");
  const chunkNdjson = chunks.map((c) => JSON.stringify(c)).join("\n");

  const files: Array<{ name: string; sha256: string; size: number; content: Uint8Array }> = [];
  const memBytes = new TextEncoder().encode(memNdjson);
  files.push({ name: "memories.ndjson", size: memBytes.length, content: memBytes, sha256: await sha256HexBytes(memBytes) });
  const chunkBytes = new TextEncoder().encode(chunkNdjson);
  files.push({
    name: "chunks.ndjson",
    size: chunkBytes.length,
    content: chunkBytes,
    sha256: await sha256HexBytes(chunkBytes),
  });

  const manifest: ExportManifest = {
    version: 1,
    workspace_id: auth.workspaceId,
    generated_at: new Date(0).toISOString(),
    counts: { memories: memories.length, chunks: chunks.length },
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size })).sort((a, b) => a.name.localeCompare(b.name)),
  };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  files.push({ name: "manifest.json", size: manifestBytes.length, content: manifestBytes, sha256: await sha256HexBytes(manifestBytes) });

  const zip = new JSZip();
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    zip.file(f.name, f.content, { date: new Date(0) });
  }
  const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
  if (archive.length > maxBytes) {
    throw createHttpError(413, "payload_too_large", `export exceeds ${maxBytes} bytes`);
  }
  const sha = await sha256HexBytes(archive);
  return { artifact_base64: b64encode(archive), bytes: archive.length, sha256: sha, archive };
}

export function wantsZipResponse(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.searchParams.get("format")?.toLowerCase() === "zip" ||
    (request.headers.get("accept") ?? "").toLowerCase().includes("application/zip")
  );
}

export async function importArtifact(
  auth: AuthContext,
  supabase: SupabaseClient,
  artifactBase64: string,
  maxBytes: number,
  mode: ImportMode = "upsert",
): Promise<ImportOutcome> {
  const allowedModes: ImportMode[] = ["upsert", "skip_existing", "error_on_conflict", "replace_ids", "replace_all"];
  if (!allowedModes.includes(mode)) {
    throw createHttpError(400, "BAD_REQUEST", "invalid import mode");
  }

  const zipBytes = b64decode(artifactBase64);
  if (zipBytes.length > maxBytes) {
    throw createHttpError(413, "payload_too_large", `artifact exceeds ${maxBytes} bytes`);
  }
  const zip = await JSZip.loadAsync(zipBytes);
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw createHttpError(400, "BAD_REQUEST", "manifest.json missing");
  const manifestText = await manifestEntry.async("string");
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(manifestText) as ExportManifest;
  } catch {
    throw createHttpError(400, "BAD_REQUEST", "manifest.json invalid");
  }
  if (manifest.workspace_id !== auth.workspaceId) {
    throw createHttpError(403, "FORBIDDEN", "Artifact workspace mismatch");
  }
  if (manifest.version !== 1) throw createHttpError(400, "BAD_REQUEST", "Unsupported manifest version");

  const readFileChecked = async (name: string) => {
    const entry = zip.file(name);
    if (!entry) throw createHttpError(400, "BAD_REQUEST", `${name} missing`);
    const bytes = new Uint8Array(await entry.async("uint8array"));
    const sha = await sha256HexBytes(bytes);
    const declared = manifest.files.find((f) => f.name === name);
    if (!declared || declared.sha256 !== sha) {
      throw createHttpError(400, "BAD_REQUEST", `${name} checksum mismatch`);
    }
    return bytes;
  };

  const memBytes = await readFileChecked("memories.ndjson");
  const chunkBytes = await readFileChecked("chunks.ndjson");

  const parseNdjson = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).trim() === ""
      ? []
      : new TextDecoder()
          .decode(bytes)
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));

  const memories = parseNdjson(memBytes).map((m) => ({ ...m, workspace_id: auth.workspaceId }));
  const chunks = parseNdjson(chunkBytes).map((c) => ({ ...c, workspace_id: auth.workspaceId }));

  const memIds = memories.map((m) => m.id);
  const chunkIds = chunks.map((c) => c.id);

  const fetchExistingIds = async (table: "memories" | "memory_chunks", ids: string[]): Promise<Set<string>> => {
    if (!ids.length) return new Set<string>();
    const { data, error } = await supabase
      .from(table)
      .select("id", { count: "exact" })
      .eq("workspace_id", auth.workspaceId)
      .in("id", ids);
    if (error) {
      throw createHttpError(500, "DB_ERROR", error.message ?? `Failed to check existing ${table}`);
    }
    return new Set((data ?? []).map((r: { id: string }) => r.id));
  };

  const ensureOk = (result: { error: { message?: string } | null }, fallback: string) => {
    if (result.error) throw createHttpError(500, "DB_ERROR", result.error.message ?? fallback);
  };

  let memoriesToWrite = memories;
  let chunksToWrite = chunks;

  if (mode === "error_on_conflict") {
    const existingMemIds = await fetchExistingIds("memories", memIds);
    const existingChunkIds = await fetchExistingIds("memory_chunks", chunkIds);
    if (existingMemIds.size > 0 || existingChunkIds.size > 0) {
      throw createHttpError(409, "CONFLICT", "Import conflicts with existing ids");
    }
  }

  if (mode === "skip_existing") {
    const existingMemIds = await fetchExistingIds("memories", memIds);
    memoriesToWrite = memories.filter((m) => !existingMemIds.has(m.id));
    const allowedMemoryIds = new Set(memoriesToWrite.map((m) => m.id));
    const existingChunkIds = await fetchExistingIds("memory_chunks", chunkIds);
    chunksToWrite = chunks.filter((c) => !existingChunkIds.has(c.id) && allowedMemoryIds.has(c.memory_id));
  }

  if (mode === "replace_all") {
    const delChunks = await supabase.from("memory_chunks").delete().eq("workspace_id", auth.workspaceId);
    ensureOk(delChunks, "Failed to clear chunks");
    const delMems = await supabase.from("memories").delete().eq("workspace_id", auth.workspaceId);
    ensureOk(delMems, "Failed to clear memories");
  }

  if (mode === "replace_ids") {
    if (memories.length > 0) {
      const delChunks = await supabase.from("memory_chunks").delete().eq("workspace_id", auth.workspaceId).in("memory_id", memIds);
      ensureOk(delChunks, "Failed to delete chunks by id");
      const delMems = await supabase.from("memories").delete().eq("workspace_id", auth.workspaceId).in("id", memIds);
      ensureOk(delMems, "Failed to delete memories by id");
    }
  }

  let importedMemories = 0;
  let importedChunks = 0;

  if (memoriesToWrite.length > 0) {
    if (mode === "upsert") {
      const res = await supabase.from("memories").upsert(memoriesToWrite, { onConflict: "id" });
      ensureOk(res, "Failed to import memories");
    } else {
      const res = await supabase.from("memories").insert(memoriesToWrite);
      ensureOk(res, "Failed to import memories");
    }
    importedMemories = memoriesToWrite.length;
  }

  if (chunksToWrite.length > 0) {
    if (mode === "upsert") {
      const res = await supabase.from("memory_chunks").upsert(chunksToWrite, { onConflict: "id" });
      ensureOk(res, "Failed to import chunks");
    } else {
      const res = await supabase.from("memory_chunks").insert(chunksToWrite);
      ensureOk(res, "Failed to import chunks");
    }
    importedChunks = chunksToWrite.length;
  }

  return { imported_memories: importedMemories, imported_chunks: importedChunks };
}


export function chunkText(text: string, chunkSize = 800, overlap = 100): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);

  const pushChunk = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
  };

  let buffer = "";
  const flushBuffer = () => {
    if (buffer.trim().length > 0) {
      pushChunk(buffer);
      buffer = "";
    }
  };

  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      flushBuffer();
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + chunkSize, para.length);
        pushChunk(para.slice(start, end));
        if (end === para.length) break;
        start = Math.max(end - overlap, start + 1);
      }
      continue;
    }

    if (buffer.length === 0) {
      buffer = para;
      continue;
    }

    const candidate = `${buffer}\n\n${para}`;
    if (candidate.length <= chunkSize) {
      buffer = candidate;
    } else {
      flushBuffer();
      buffer = para;
    }
  }

  flushBuffer();
  return chunks;
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashApiKey(rawKey: string, salt: string): Promise<string> {
  return sha256Hex(salt + rawKey);
}

let cachedSalt: string | null = null;
async function getApiKeySalt(
  env: Env,
  supabase: SupabaseClient,
): Promise<{ salt: string; mismatchFatal: boolean }> {
  const envSalt = env.API_KEY_SALT || "";
  const { data, error } = await supabase.from("app_settings").select("api_key_salt").limit(1).single();
  const dbSalt = (data as { api_key_salt?: string } | null)?.api_key_salt ?? "";
  if (error && !envSalt && cachedSalt !== null) {
    return { salt: cachedSalt, mismatchFatal: false };
  }

  if (envSalt && dbSalt && envSalt !== dbSalt) {
    const requestId = generateRequestId();
    logger.error({
      event: "api_key_salt_mismatch",
      request_id: requestId,
      env_present: Boolean(envSalt),
      db_present: Boolean(dbSalt),
      env_length: envSalt.length,
      db_length: dbSalt.length,
    });
    return { salt: envSalt, mismatchFatal: true };
  }

  const saltToUse = envSalt || dbSalt || cachedSalt || "";
  cachedSalt = saltToUse;
  return { salt: saltToUse, mismatchFatal: false };
}

async function embedText(texts: string[], env: Env): Promise<number[][]> {
  const mode = (env.EMBEDDINGS_MODE || "openai").toLowerCase();
  if (mode === "stub") {
    return texts.map((t) => stubEmbedding(t));
  }

  if (!env.OPENAI_API_KEY) {
    throw createHttpError(500, "CONFIG_ERROR", "OPENAI_API_KEY not set");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw createHttpError(500, "EMBED_ERROR", `Embedding request failed: ${response.status} ${message}`);
  }

  const json = (await response.json()) as {
    data: { embedding: number[] }[];
  };

  if (!json.data || json.data.length !== texts.length) {
    throw createHttpError(500, "EMBED_ERROR", "Embedding response missing data");
  }

  return json.data.map((item) => item.embedding);
}

function vectorToPgvectorString(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

type MatchResult = {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  chunk_text: string;
  score: number;
};

type FusionResult = {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  text: string;
  score: number;
};

async function callMatchVector(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    userId: string;
    namespace: string;
    queryEmbedding: string;
    matchCount: number;
    metadata?: MetadataFilter;
    startTime?: string;
    endTime?: string;
  },
): Promise<MatchResult[]> {
  const { data, error } = await supabase.rpc("match_chunks_vector", {
    p_workspace_id: args.workspaceId,
    p_user_id: args.userId,
    p_namespace: args.namespace,
    p_query_embedding: args.queryEmbedding,
    p_match_count: args.matchCount,
    p_metadata: args.metadata ?? null,
    p_start_time: args.startTime ?? null,
    p_end_time: args.endTime ?? null,
  });

  if (error) {
    throw createHttpError(500, "DB_ERROR", `match_chunks_vector failed: ${error.message}`);
  }
  return (data ?? []) as MatchResult[];
}

async function callMatchText(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    userId: string;
    namespace: string;
    query: string;
    matchCount: number;
    metadata?: MetadataFilter;
    startTime?: string;
    endTime?: string;
  },
): Promise<MatchResult[]> {
  const { data, error } = await supabase.rpc("match_chunks_text", {
    p_workspace_id: args.workspaceId,
    p_user_id: args.userId,
    p_namespace: args.namespace,
    p_query: args.query,
    p_match_count: args.matchCount,
    p_metadata: args.metadata ?? null,
    p_start_time: args.startTime ?? null,
    p_end_time: args.endTime ?? null,
  });
  if (error) {
    throw createHttpError(500, "DB_ERROR", `match_chunks_text failed: ${error.message}`);
  }
  return (data ?? []) as MatchResult[];
}

function reciprocalRankFusion(
  vectorResults: MatchResult[],
  textResults: MatchResult[],
  topK: number,
): FusionResult[] {
  const scores = new Map<string, FusionResult & { rrf: number }>();

  const applyList = (list: MatchResult[]) => {
    list.forEach((item, idx) => {
      const rrfScore = 1 / (RRF_K + idx + 1);
      const existing = scores.get(item.chunk_id);
      const combinedScore = (existing?.rrf ?? 0) + rrfScore;
      scores.set(item.chunk_id, {
        chunk_id: item.chunk_id,
        memory_id: item.memory_id,
        chunk_index: item.chunk_index,
        text: item.chunk_text,
        score: combinedScore,
        rrf: combinedScore,
      });
    });
  };

  applyList(vectorResults);
  applyList(textResults);

  return Array.from(scores.values())
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-12) return diff;
      return a.chunk_id.localeCompare(b.chunk_id);
    })
    .slice(0, topK)
    .map(({ rrf, ...rest }) => {
      void rrf;
      return rest;
    });
}

function normalizeTextKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function dedupeFusionResults(results: FusionResult[]): FusionResult[] {
  const seen = new Set<string>();
  const deduped: FusionResult[] = [];
  for (const res of results) {
    const key = normalizeTextKey(res.text);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(res);
  }
  return deduped;
}

type SearchOutcome = {
  results: FusionResult[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
};

type ListOutcome = {
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
};

type ExportOutcome = { artifact_base64: string; bytes: number; sha256: string; archive: Uint8Array };

type ImportOutcome = { imported_memories: number; imported_chunks: number };

export function finalizeResults(
  fused: FusionResult[],
  page: number,
  page_size: number,
): { results: FusionResult[]; total: number; has_more: boolean } {
  const deduped = dedupeFusionResults(fused);
  const offset = (page - 1) * page_size;
  const paged = deduped.slice(offset, offset + page_size);
  const total = deduped.length;
  return { results: paged, total, has_more: offset + page_size < total };
}

async function performSearch(
  auth: AuthContext,
  payload: SearchPayload,
  env: Env,
  supabase: SupabaseClient,
): Promise<SearchOutcome> {
  const params = normalizeSearchPayload(payload);
  const { user_id, query, namespace, top_k, page, page_size, filters } = params;
  const today = todayUtc();

  const desired = Math.min(MAX_FUSE_RESULTS, Math.max(top_k, page * page_size));
  const matchCount = Math.min(SEARCH_MATCH_COUNT, desired * 3);

  const queryEmbedding = (await embedText([query], env))[0];
  const embeddingVector = vectorToPgvectorString(queryEmbedding);

  const [vectorResults, textResults] = await Promise.all([
    callMatchVector(supabase, {
      workspaceId: auth.workspaceId,
      userId: user_id,
      namespace,
      queryEmbedding: embeddingVector,
      matchCount,
      metadata: filters.metadata,
      startTime: filters.start_time,
      endTime: filters.end_time,
    }),
    callMatchText(supabase, {
      workspaceId: auth.workspaceId,
      userId: user_id,
      namespace,
      query,
      matchCount,
      metadata: filters.metadata,
      startTime: filters.start_time,
      endTime: filters.end_time,
    }),
  ]);

  await bumpUsage(supabase, auth.workspaceId, today, {
    writesDelta: 0,
    readsDelta: 1,
    embedsDelta: 1,
  });

  const fused = reciprocalRankFusion(vectorResults, textResults, Math.min(matchCount, MAX_FUSE_RESULTS));
  const final = finalizeResults(fused, page, page_size);

  return {
    results: final.results,
    total: final.total,
    page,
    page_size,
    has_more: final.has_more,
  };
}

export async function performListMemories(
  auth: AuthContext,
  params: MemoryListParams,
  supabase: SupabaseClient,
): Promise<ListOutcome> {
  const { page, page_size, namespace, user_id, filters } = params;
  const offset = (page - 1) * page_size;

  let query = supabase
    .from("memories")
    .select("id, user_id, namespace, text, metadata, created_at", { count: "exact" })
    .eq("workspace_id", auth.workspaceId);

  if (namespace) query = query.eq("namespace", namespace);
  if (user_id) query = query.eq("user_id", user_id);
  if (filters.metadata) query = query.contains("metadata", filters.metadata);
  if (filters.start_time) query = query.gte("created_at", filters.start_time);
  if (filters.end_time) query = query.lte("created_at", filters.end_time);

  query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
  query = query.range(offset, offset + page_size - 1);

  const { data, error, count } = await query;
  if (error) {
    throw createHttpError(500, "DB_ERROR", error.message ?? "Failed to list memories");
  }

  const total = typeof count === "number" ? count : data?.length ?? 0;
  const has_more = offset + (data?.length ?? 0) < total;

  return {
    results: (data ?? []) as ListOutcome["results"],
    total,
    page,
    page_size,
    has_more,
  };
}

export {
  emitAuditLog,
  handleCreateApiKey,
  handleListApiKeys,
  handleRevokeApiKey,
  handleBillingStatus,
  handleBillingCheckout,
  handleBillingPortal,
  handleBillingWebhook,
  handleUsageToday,
  handleSearch,
  handleCreateMemory,
  handleContext,
  parseApiKeyMeta,
  redact,
};
function createHttpError(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): ApiError & Error {
  const err = new Error(message) as ApiError & Error;
  err.code = code;
  err.status = status;
  err.message = message;
  err.headers = headers;
  return err;
}

function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

// Stub embeddings (deterministic) for dev
const STUB_EMBED_DIM = 1536;
function stubEmbedding(text: string): number[] {
  const seed = hashStringToInt(text);
  const rng = mulberry32(seed);
  const arr = new Array(STUB_EMBED_DIM);
  for (let i = 0; i < STUB_EMBED_DIM; i++) {
    arr[i] = rng() * 2 - 1; // [-1, 1)
  }
  return arr;
}

function hashStringToInt(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0) || 1;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Usage accounting
type UsageRow = {
  workspace_id: string;
  day: string;
  writes: number;
  reads: number;
  embeds: number;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getUsage(
  supabase: SupabaseClient,
  workspaceId: string,
  day: string,
): Promise<UsageRow> {
  const { data, error } = await supabase
    .from("usage_daily")
    .select("workspace_id, day, writes, reads, embeds")
    .eq("workspace_id", workspaceId)
    .eq("day", day)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw createHttpError(500, "DB_ERROR", `Failed to fetch usage: ${error.message}`);
  }

  if (!data) {
    return { workspace_id: workspaceId, day, writes: 0, reads: 0, embeds: 0 };
  }

  return data as UsageRow;
}

async function bumpUsage(
  supabase: SupabaseClient,
  workspaceId: string,
  day: string,
  deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
): Promise<UsageRow> {
  const { data, error } = await supabase.rpc("bump_usage_rpc", {
    p_workspace_id: workspaceId,
    p_day: day,
    p_writes: deltas.writesDelta,
    p_reads: deltas.readsDelta,
    p_embeds: deltas.embedsDelta,
  });

  if (error || !data) {
    throw createHttpError(500, "DB_ERROR", `Failed to bump usage: ${error?.message}`);
  }

  return data as UsageRow;
}

export async function deleteMemoryCascade(
  supabase: SupabaseClient,
  workspaceId: string,
  memoryId: string,
): Promise<boolean> {
  const { error: chunksError } = await supabase
    .from("memory_chunks")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("memory_id", memoryId);

  if (chunksError) {
    throw createHttpError(500, "DB_ERROR", chunksError.message ?? "Failed to delete memory chunks");
  }

  const { error: memError, count } = await supabase
    .from("memories")
    .delete({ count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("id", memoryId);

  if (memError) {
    throw createHttpError(500, "DB_ERROR", memError.message ?? "Failed to delete memory");
  }

  return (count ?? 0) > 0;
}

// Rate limiting backed by KV (survives restarts)
export function safeKvTtl(ttlSec: number): number {
  const numeric = Number.isFinite(ttlSec) ? Number(ttlSec) : 0;
  if (numeric <= 0) return 60;
  return Math.max(60, Math.ceil(numeric));
}

export { performSearch };

async function rateLimit(
  key: string,
  env: Env,
): Promise<{ allowed: boolean; headers: Record<string, string> }> {
  if ((env.RATE_LIMIT_MODE ?? "on").toLowerCase() === "off") return { allowed: true, headers: {} };
  const ns = env.RATE_LIMIT_DO;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    return { allowed: true, headers: {} };
  }
  const name = `rl:${key}`;
  const id = ns.idFromName(name);
  const stub = ns.get(id);
  let resp: Response;
  try {
    resp = await stub.fetch("https://rate-limit/check", { method: "POST" });
  } catch (err) {
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Rate limit service unavailable");
  }
  if (!resp.ok) {
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Rate limit service unavailable");
  }
  const data = (await resp.json()) as { allowed: boolean; count: number; limit: number; reset: number };
  const nowSec = Math.floor(Date.now() / 1000);
  const retryAfter = Math.max(0, data.reset - nowSec);
  const headers = {
    "x-ratelimit-limit": data.limit.toString(),
    "x-ratelimit-remaining": Math.max(0, data.limit - data.count).toString(),
    "x-ratelimit-reset": data.reset.toString(),
    "retry-after": retryAfter.toString(),
  };
  return { allowed: data.allowed, headers };
}

// Admin helpers
async function requireAdmin(request: Request, env: Env): Promise<{ token: string }> {
  const token = request.headers.get("x-admin-token");
  if (!token || token !== env.MASTER_ADMIN_TOKEN) {
    throw createHttpError(401, "UNAUTHORIZED", "Invalid admin token");
  }
  return { token };
}

async function handleCreateWorkspace(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
): Promise<Response> {
  const { token } = await requireAdmin(request, env);
  const rate = await rateLimit(`admin:${token}`, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const body = await safeParseJson<{ name: string }>(request);
  if (!body.ok || !body.data.name) {
    return jsonResponse({ error: { code: "BAD_REQUEST", message: "name is required" } }, 400, rate.headers);
  }

  const { data, error } = await supabase
    .from("workspaces")
    .insert({ name: body.data.name })
    .select("id, name")
    .single();

  if (error || !data) {
    return jsonResponse(
      { error: { code: "DB_ERROR", message: error?.message ?? "Failed to create workspace" } },
      500,
      rate.headers,
    );
  }

  void emitProductEvent(
    supabase,
    "workspace_created",
    { workspaceId: data.id, route: "/v1/workspaces", method: "POST", status: 200 },
  );

  return jsonResponse({ workspace_id: data.id, name: data.name }, 200, rate.headers);
}

async function handleCreateApiKey(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
): Promise<Response> {
  const { token } = await requireAdmin(request, env);
  const rate = await rateLimit(`admin:${token}`, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const body = await safeParseJson<{ workspace_id: string; name: string }>(request);
  if (!body.ok || !body.data.workspace_id || !body.data.name) {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: "workspace_id and name are required" } },
      400,
      rate.headers,
    );
  }

  const rawKey = generateApiKey();
  const saltOutcome = await getApiKeySalt(env, supabase);
  const keyHash = await hashApiKey(rawKey, saltOutcome.salt);
  if ((env.AUTH_DEBUG ?? "").trim() === "1") {
    console.info("auth_debug_create", { hash_prefix: keyHash.slice(0, 12) });
  }

  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      workspace_id: body.data.workspace_id,
      name: body.data.name,
      key_hash: keyHash,
      key_prefix: rawKey.split("_").slice(0, 2).join("_"), // "mn_live"
      key_last4: rawKey.slice(-4),
    })
    .select("id, workspace_id, name, key_prefix, key_last4, created_at, revoked_at")
    .single();

  if (error || !data) {
    return jsonResponse(
      { error: { code: "DB_ERROR", message: error?.message ?? "Failed to create api key" } },
      500,
      rate.headers,
    );
  }

  const stubKeys = (supabase as unknown as { __rawApiKeys?: Map<string, { workspaceId: string }> }).__rawApiKeys;
  if (stubKeys) {
    stubKeys.set(rawKey, { workspaceId: body.data.workspace_id });
  }

  void emitProductEvent(
    supabase,
    "api_key_created",
    { workspaceId: data.workspace_id as string, route: "/v1/api-keys", method: "POST", status: 200 },
    { key_prefix: (data as { key_prefix?: string }).key_prefix ?? "mn_live" },
  );

  return jsonResponse(
    { api_key: rawKey, api_key_id: data.id, workspace_id: data.workspace_id, name: data.name },
    200,
    rate.headers,
  );
}

async function handleListApiKeys(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
): Promise<Response> {
  const { token } = await requireAdmin(request, env);
  const rate = await rateLimit(`admin:${token}`, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspace_id");
  if (!workspaceId) {
    return jsonResponse({ error: { code: "BAD_REQUEST", message: "workspace_id is required" } }, 400, rate.headers);
  }

  const { data, error } = await supabase
    .from("api_keys")
    .select("id, workspace_id, name, created_at, revoked_at, key_prefix, key_last4")
    .eq("workspace_id", workspaceId);

  if (error) {
    return jsonResponse(
      { error: { code: "DB_ERROR", message: error.message ?? "Failed to list api keys" } },
      500,
      rate.headers,
    );
  }

  const masked =
    data?.map((k) => ({
      id: k.id,
      workspace_id: k.workspace_id,
      name: k.name,
      created_at: k.created_at,
      revoked_at: k.revoked_at,
      key_prefix: (k as { key_prefix?: string }).key_prefix ?? "mn_live",
      key_last4: (k as { key_last4?: string }).key_last4 ?? "****",
    })) ?? [];

  return jsonResponse({ api_keys: masked }, 200, rate.headers);
}

async function handleRevokeApiKey(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
): Promise<Response> {
  const { token } = await requireAdmin(request, env);
  const rate = await rateLimit(`admin:${token}`, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const body = await safeParseJson<{ api_key_id: string }>(request);
  if (!body.ok || !body.data.api_key_id) {
    return jsonResponse({ error: { code: "BAD_REQUEST", message: "api_key_id is required" } }, 400, rate.headers);
  }

  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", body.data.api_key_id);

  if (error) {
    return jsonResponse(
      { error: { code: "DB_ERROR", message: error.message ?? "Failed to revoke api key" } },
      500,
      rate.headers,
    );
  }

  return jsonResponse({ revoked: true }, 200, rate.headers);
}

async function handleReprocessDeferredWebhooks(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  requestId = "",
): Promise<Response> {
  const { token } = await requireAdmin(request, env);
  const rate = await rateLimit(`admin:${token}`, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const url = new URL(request.url);
  const statusFilterRaw = (url.searchParams.get("status") ?? "deferred").trim().toLowerCase();
  if (statusFilterRaw !== "deferred" && statusFilterRaw !== "failed") {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: "status must be one of: deferred, failed" } },
      400,
      rate.headers,
    );
  }
  const parsedLimit = Number(url.searchParams.get("limit") ?? DEFAULT_WEBHOOK_REPROCESS_LIMIT);
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(500, Math.floor(parsedLimit)))
    : DEFAULT_WEBHOOK_REPROCESS_LIMIT;

  emitEventLog("webhook_reprocess_started", {
    route: "/admin/webhooks/reprocess",
    method: "POST",
    request_id: requestId || null,
    status_filter: statusFilterRaw,
    limit,
  });

  const pending = await supabase
    .from("payu_webhook_events")
    .select("event_id,payload,event_created")
    .eq("status", statusFilterRaw)
    .order("event_created", { ascending: true })
    .limit(limit);
  if (pending.error) {
    return jsonResponse(
      { error: { code: "DB_ERROR", message: pending.error.message ?? "Failed to list deferred webhooks" } },
      500,
      rate.headers,
    );
  }

  const rows = ((pending.data as Array<{ event_id?: unknown; payload?: unknown }> | null) ?? [])
    .filter((row) => typeof row.event_id === "string" && row.event_id.trim().length > 0) as Array<{
    event_id: string;
    payload?: unknown;
    event_created?: number | null;
  }>;

  let processed = 0;
  let replayed = 0;
  let deferred = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const payload = (row.payload ?? {}) as PayUWebhookPayload;
      const outcome = await reconcilePayUWebhook(
        payload,
        supabase,
        env,
        `${requestId || "admin-reprocess"}:${row.event_id}`,
        row.event_id,
      );
      if (outcome.outcome === "replayed") {
        replayed += 1;
        emitEventLog("webhook_reprocess_skipped", {
          route: "/admin/webhooks/reprocess",
          method: "POST",
          request_id: requestId || null,
          payu_event_id: row.event_id,
          replay_status: outcome.replayStatus ?? null,
        });
        continue;
      }
      if (outcome.outcome === "deferred") {
        deferred += 1;
        emitEventLog("webhook_reprocess_skipped", {
          route: "/admin/webhooks/reprocess",
          method: "POST",
          request_id: requestId || null,
          payu_event_id: row.event_id,
          reason: outcome.deferReason ?? "workspace_not_found",
        });
        continue;
      }
      processed += 1;
      emitEventLog("webhook_reprocess_processed", {
        route: "/admin/webhooks/reprocess",
        method: "POST",
        request_id: requestId || null,
        payu_event_id: row.event_id,
        outcome: outcome.outcome,
      });
    } catch (err) {
      failed += 1;
      emitEventLog("webhook_reprocess_failed", {
        route: "/admin/webhooks/reprocess",
        method: "POST",
        request_id: requestId || null,
        payu_event_id: row.event_id,
        error_message: redact((err as Error)?.message, "message"),
      });
    }
  }

  return jsonResponse(
    {
      scanned: rows.length,
      processed,
      replayed,
      deferred,
      failed,
      status_filter: statusFilterRaw,
    },
    200,
    rate.headers,
  );
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `mn_live_${hex}`;
}

// ---------- Export / Import ----------
type ExportPayload = { format?: string };
type ImportMode = "upsert" | "skip_existing" | "error_on_conflict" | "replace_ids" | "replace_all";
type ImportPayload = { artifact_base64: string; mode?: ImportMode };

export function makeExportResponse(
  outcome: ExportOutcome,
  wantsZip: boolean,
  auth: AuthContext,
  rateHeaders: Record<string, string>,
): Response {
  if (wantsZip) {
    const date = new Date().toISOString().slice(0, 10);
    const buf = outcome.archive.buffer
      .slice(outcome.archive.byteOffset, outcome.archive.byteOffset + outcome.archive.byteLength) as ArrayBuffer;
    const headers = {
      ...rateHeaders,
      ...getCorsHeaders(),
      ...getSecurityHeaders(),
      ...getRequestIdHeaders(),
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="memorynode-export-${auth.workspaceId}-${date}.zip"`,
    };
    return new Response(buf as BodyInit, { status: 200, headers });
  }

  return jsonResponse(
    { artifact_base64: outcome.artifact_base64, bytes: outcome.bytes, sha256: outcome.sha256 },
    200,
    {
      ...rateHeaders,
      "content-type": "application/json",
    },
  );
}

async function handleExport(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
  }
  const payload = await safeParseJson<ExportPayload>(request);
  if (!payload.ok) return jsonResponse({ error: { code: "BAD_REQUEST", message: payload.error } }, 400, rate.headers);

  const wantsZip = wantsZipResponse(request);
  const maxBytes = Number(env.MAX_EXPORT_BYTES ?? DEFAULT_MAX_EXPORT_BYTES);
  const outcome = await buildExportArtifact(auth, supabase, maxBytes);

  return makeExportResponse(outcome, wantsZip, auth, rate.headers);
}

async function handleImport(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
  }
  const payload = await safeParseJson<ImportPayload>(request);
  if (!payload.ok || !payload.data.artifact_base64) {
    return jsonResponse({ error: { code: "BAD_REQUEST", message: "artifact_base64 is required" } }, 400, rate.headers);
  }
  if (payload.data.mode && !["upsert", "skip_existing", "error_on_conflict", "replace_ids", "replace_all"].includes(payload.data.mode)) {
    return jsonResponse({ error: { code: "BAD_REQUEST", message: "invalid import mode" } }, 400, rate.headers);
  }

  const maxBytes = Number(env.MAX_IMPORT_BYTES ?? DEFAULT_MAX_IMPORT_BYTES);
  const outcome = await importArtifact(auth, supabase, payload.data.artifact_base64, maxBytes, payload.data.mode);
  return jsonResponse(
    { imported_memories: outcome.imported_memories, imported_chunks: outcome.imported_chunks },
    200,
    rate.headers,
  );
}

async function handleUsageToday(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const day = todayUtc();
  const usage = await getUsage(supabase, auth.workspaceId, day);
  const caps = capsByPlan[effectivePlan(auth.plan, auth.planStatus)] ?? capsByPlan.free;
  return jsonResponse(
    {
      day,
      writes: usage.writes,
      reads: usage.reads,
      embeds: usage.embeds,
      plan: auth.plan,
      limits: caps,
    },
    200,
    rate.headers,
  );
}

async function handleBillingStatus(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
  requestId = "",
): Promise<Response> {
  if (!isPayUBillingConfigured(env)) {
    return jsonResponse(
      { error: { code: "BILLING_NOT_CONFIGURED", message: "Missing PayU configuration" } },
      503,
    );
  }
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const { data, error } = await supabase
    .from("workspaces")
    .select("plan, plan_status, current_period_end, cancel_at_period_end")
    .eq("id", auth.workspaceId)
    .single();

  if (error || !data) {
    emitEventLog("billing_endpoint_error", {
      route: "/v1/billing/status",
      method: "GET",
      status: 500,
      request_id: requestId,
      workspace_id_redacted: redact(auth.workspaceId, "workspace_id"),
    });
    return jsonResponse(
      { error: { code: "DB_ERROR", message: error?.message ?? "Failed to load billing status" } },
      500,
      rate.headers,
    );
  }

  return jsonResponse(
    {
      plan: (data as { plan?: string }).plan ?? "free",
      plan_status: normalizePlanStatus((data as { plan_status?: string }).plan_status) ?? "free",
      current_period_end: (data as { current_period_end?: string | null }).current_period_end ?? null,
      cancel_at_period_end: (data as { cancel_at_period_end?: boolean }).cancel_at_period_end ?? false,
      effective_plan: effectivePlan(
        (data as { plan?: AuthContext["plan"] }).plan ?? "free",
        normalizePlanStatus((data as { plan_status?: string }).plan_status),
      ),
    },
    200,
    rate.headers,
  );
}

async function handleBillingCheckout(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
  requestId = "",
): Promise<Response> {
  const parsedBody = await safeParseJson<{ plan?: AuthContext["plan"]; firstname?: string; email?: string; phone?: string }>(request);
  const requestedPlan = parsedBody.ok ? parsedBody.data.plan : undefined;
  if (requestedPlan && requestedPlan !== "pro" && requestedPlan !== "free") {
    return jsonResponse(
      {
        error: {
          code: "PLAN_NOT_SUPPORTED",
          message: "Platform-only billing is enabled; seat/team pricing is not available.",
        },
      },
      400,
    );
  }
  assertPayUEnvFor("/v1/billing/checkout", env);

  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }

  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", auth.workspaceId)
    .single();

  if (error || !data) {
    return jsonResponse(
      { error: { code: "DB_ERROR", message: error?.message ?? "Failed to load workspace" } },
      500,
      rate.headers,
    );
  }

  const monthKey = new Date().toISOString().slice(0, 7).replace("-", "");
  const clientIdem = request.headers.get("Idempotency-Key") ?? request.headers.get("idempotency-key");
  const workspaceHash = await shortHash(auth.workspaceId, 8);
  const idemHash = clientIdem ? await shortHash(clientIdem, 8) : "default1";
  const txnId = `mn${monthKey}${workspaceHash}${idemHash}`.slice(0, 40);

  const updated = await supabase
    .from("workspaces")
    .update({
      billing_provider: "payu",
      payu_txn_id: txnId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", auth.workspaceId);
  if (updated.error) {
    emitEventLog("billing_endpoint_error", {
      route: "/v1/billing/checkout",
      method: "POST",
      status: 500,
      request_id: requestId,
      workspace_id_redacted: redact(auth.workspaceId, "workspace_id"),
    });
    return jsonResponse(
      { error: { code: "DB_ERROR", message: updated.error.message ?? "Failed to persist PayU transaction id" } },
      500,
      rate.headers,
    );
  }

  const successUrl = new URL(env.PAYU_SUCCESS_PATH ?? DEFAULT_SUCCESS_PATH, env.PUBLIC_APP_URL!).toString();
  const cancelUrl = new URL(env.PAYU_CANCEL_PATH ?? DEFAULT_CANCEL_PATH, env.PUBLIC_APP_URL!).toString();
  const amount = normalizeMoneyString(env.PAYU_PRO_AMOUNT);
  const productInfo = (env.PAYU_PRODUCT_INFO ?? DEFAULT_PAYU_PRODUCT_INFO).trim();
  const firstname = (parsedBody.ok ? parsedBody.data.firstname : undefined)?.trim() || "MemoryNode";
  const email = (parsedBody.ok ? parsedBody.data.email : undefined)?.trim() || `${auth.workspaceId}@payu.local`;
  const phone = (parsedBody.ok ? parsedBody.data.phone : undefined)?.trim() || "";

  const hashInput = [
    env.PAYU_MERCHANT_KEY!,
    txnId,
    amount,
    productInfo,
    firstname,
    email,
    auth.workspaceId,
    "pro",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    env.PAYU_MERCHANT_SALT!,
  ].join("|");
  const hash = await computeSha512Hex(hashInput);

  const checkoutFields = {
    key: env.PAYU_MERCHANT_KEY!,
    txnid: txnId,
    amount,
    productinfo: productInfo,
    firstname,
    email,
    phone,
    surl: successUrl,
    furl: cancelUrl,
    hash,
    udf1: auth.workspaceId,
    udf2: "pro",
  };

  void emitProductEvent(
    supabase,
    "checkout_started",
    {
      workspaceId: auth.workspaceId,
      requestId,
      route: "/v1/billing/checkout",
      method: "POST",
      status: 200,
      effectivePlan: effectivePlan(auth.plan, auth.planStatus),
      planStatus: auth.planStatus,
    },
    { txn_id: redact(txnId, "payu_txn_id"), provider: "payu" },
  );

  return jsonResponse(
    {
      provider: "payu",
      method: "POST",
      url: normalizePayUBaseUrl(env.PAYU_BASE_URL!),
      fields: checkoutFields,
    },
    200,
    rate.headers,
  );
}

async function handleBillingPortal(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
  requestId = "",
): Promise<Response> {
  const auth = await authenticate(request, env, supabase, auditCtx);
  const rate = await rateLimit(auth.keyHash, env);
  if (!rate.allowed) {
    return jsonResponse(
      { error: { code: "rate_limited", message: "Rate limit exceeded" } },
      429,
      rate.headers,
    );
  }
  return jsonResponse(
    {
      error: {
        code: "GONE",
        message: "Stripe billing portal has been removed. PayU billing is platform-only via checkout/webhooks.",
      },
      ...(requestId ? { request_id: requestId } : {}),
    },
    410,
    rate.headers,
  );
}

function resolveBillingWebhooksEnabled(env: Env): boolean {
  const raw = (env.BILLING_WEBHOOKS_ENABLED ?? "1").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return true;
}

async function handleBillingWebhook(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  requestId = "",
): Promise<Response> {
  if (!resolveBillingWebhooksEnabled(env)) {
    emitEventLog("webhook_disabled", {
      route: "/v1/billing/webhook",
      method: "POST",
      status: 503,
      request_id: requestId || null,
    });
    return jsonResponse(
      {
        error: {
          code: "BILLING_WEBHOOKS_DISABLED",
          message: "Billing webhooks are temporarily disabled",
        },
        ...(requestId ? { request_id: requestId } : {}),
      },
      503,
    );
  }
  assertPayUEnvFor("/v1/billing/webhook", env);
  emitEventLog("webhook_received", {
    route: "/v1/billing/webhook",
    method: "POST",
    request_id: requestId || null,
    provider: "payu",
  });

  const rawBody = await request.text();
  const payload = parseWebhookPayload(rawBody, (request.headers.get("content-type") ?? "").toLowerCase());
  if (!asNonEmptyString(payload.txnid) || !asNonEmptyString(payload.status)) {
    return jsonResponse(
      {
        error: { code: "BAD_REQUEST", message: "txnid and status are required in PayU webhook payload" },
        ...(requestId ? { request_id: requestId } : {}),
      },
      400,
    );
  }

  try {
    const valid = await isPayUWebhookSignatureValid(payload, rawBody, request, env);
    if (!valid) {
      emitEventLog("billing_webhook_signature_invalid", {
        route: "/v1/billing/webhook",
        method: "POST",
        status: 400,
        request_id: requestId,
      });
      return jsonResponse(
        {
          error: { code: "invalid_webhook_signature", message: "Invalid PayU signature" },
          ...(requestId ? { request_id: requestId } : {}),
        },
        400,
      );
    }
  } catch (err) {
    logger.error({
      event: "webhook_failed",
      route: "/v1/billing/webhook",
      method: "POST",
      status: 400,
      request_id: requestId || null,
      error_code: "invalid_webhook_signature",
      err,
    });
    return jsonResponse(
      {
        error: { code: "invalid_webhook_signature", message: "Invalid PayU signature" },
        ...(requestId ? { request_id: requestId } : {}),
      },
      400,
    );
  }

  try {
    const payuEventId = resolvePayUEventId(payload);
    const eventCreated = resolvePayUEventCreated(payload);
    emitEventLog("webhook_verified", {
      route: "/v1/billing/webhook",
      method: "POST",
      request_id: requestId || null,
      payu_event_id: payuEventId,
      event_type: resolvePayUEventType(payload),
      event_created: eventCreated,
      provider: "payu",
    });
    const outcome = await reconcilePayUWebhook(payload, supabase, env, requestId);
    if (outcome.outcome === "replayed") {
      emitEventLog("webhook_replayed", {
        route: "/v1/billing/webhook",
        method: "POST",
        status: 200,
        request_id: requestId || null,
        payu_event_id: outcome.payuEventId,
        event_type: outcome.eventType,
        event_created: outcome.eventCreated,
        replay_status: outcome.replayStatus ?? null,
      });
    } else {
      if (outcome.outcome === "deferred") {
        emitEventLog("webhook_deferred", {
          route: "/v1/billing/webhook",
          method: "POST",
          status: 202,
          request_id: requestId || null,
          payu_event_id: outcome.payuEventId,
          event_type: outcome.eventType,
          event_created: outcome.eventCreated,
          reason: outcome.deferReason ?? "workspace_not_found",
          txn_id_redacted: redact(outcome.txnId, "payu_txn_id"),
        });
        return jsonResponse(
          {
            error: {
              code: "webhook_deferred",
              message: "Webhook deferred until workspace mapping is available",
            },
            ...(requestId ? { request_id: requestId } : {}),
          },
          202,
        );
      }
      emitEventLog("webhook_processed", {
        route: "/v1/billing/webhook",
        method: "POST",
        status: 200,
        request_id: requestId || null,
        payu_event_id: outcome.payuEventId,
        event_type: outcome.eventType,
        event_created: outcome.eventCreated,
        outcome: outcome.outcome,
        workspace_id: outcome.workspaceId ?? null,
      });
    }
  } catch (err) {
    const maybeEvent = err as { payu_event_id?: unknown; event_type?: unknown };
    logger.error({
      event: "webhook_failed",
      route: "/v1/billing/webhook",
      method: "POST",
      status: isApiError(err) ? err.status ?? 500 : 500,
      request_id: requestId || null,
      payu_event_id:
        typeof maybeEvent.payu_event_id === "string" ? maybeEvent.payu_event_id : null,
      event_type: typeof maybeEvent.event_type === "string" ? maybeEvent.event_type : null,
      err,
    });
    if (isApiError(err)) {
      return jsonResponse(
        {
          error: { code: err.code, message: err.message },
          ...(requestId ? { request_id: requestId } : {}),
        },
        err.status ?? 500,
      );
    }
    return jsonResponse(
      {
        error: { code: "INTERNAL", message: "Failed to process webhook" },
        ...(requestId ? { request_id: requestId } : {}),
      },
      500,
    );
  }

  return jsonResponse({ received: true }, 200);
}

function resolvePayUEventId(payload: PayUWebhookPayload): string {
  const paymentId = asNonEmptyString(payload.mihpayid);
  if (paymentId) return paymentId;
  const txnId = asNonEmptyString(payload.txnid) ?? "unknown_txn";
  const status = asNonEmptyString(payload.status) ?? "unknown_status";
  const created = resolvePayUEventCreated(payload);
  return `${txnId}:${status}:${created}`;
}

function resolvePayUEventType(payload: PayUWebhookPayload): string {
  return `payment.${normalizePayUStatus(payload.status)}`;
}

function resolvePayUEventCreated(payload: PayUWebhookPayload): number {
  const source = payload.addedon ?? (payload as { created?: unknown }).created;
  return parsePayUEventCreated(source);
}

type PayUWebhookEventRow = {
  event_id: string;
  status?: string | null;
  event_created?: number | null;
  processed_at?: string | null;
  workspace_id?: string | null;
  txn_id?: string | null;
  payment_id?: string | null;
  payu_status?: string | null;
  defer_reason?: string | null;
  request_id?: string | null;
  last_error?: string | null;
};

type PayUReconcileWebhookResult = {
  outcome: "processed" | "replayed" | "ignored_stale" | "deferred";
  payuEventId: string;
  eventType: string;
  eventCreated: number;
  workspaceId?: string | null;
  txnId?: string | null;
  paymentId?: string | null;
  replayStatus?: string | null;
  deferReason?: string | null;
};

function shouldApplyPayUEvent(
  lastEventCreatedRaw: unknown,
  lastEventIdRaw: unknown,
  incomingEventCreated: number,
  incomingEventId: string,
): boolean {
  const lastEventCreated = Number(lastEventCreatedRaw);
  if (!Number.isFinite(lastEventCreated) || lastEventCreated <= 0) return true;
  if (incomingEventCreated > lastEventCreated) return true;
  if (incomingEventCreated < lastEventCreated) return false;
  const lastEventId = typeof lastEventIdRaw === "string" ? lastEventIdRaw : "";
  if (!lastEventId) return true;
  return incomingEventId.localeCompare(lastEventId) > 0;
}

async function claimPayUWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  eventType: string,
  eventCreated: number,
  payload: PayUWebhookPayload,
  requestId = "",
): Promise<{ replayed: boolean; replayStatus?: string | null }> {
  const txnId = asNonEmptyString(payload.txnid);
  if (!txnId) throw createHttpError(400, "BAD_REQUEST", "PayU payload missing txnid");
  const paymentId = asNonEmptyString(payload.mihpayid);
  const payuStatus = normalizePayUStatus(payload.status);

  const inserted = await supabase
    .from("payu_webhook_events")
    .insert({
      event_id: eventId,
      event_type: eventType,
      event_created: eventCreated,
      txn_id: txnId,
      payment_id: paymentId,
      payu_status: payuStatus,
      status: "processing",
      request_id: requestId || null,
      payload,
      processed_at: null,
      last_error: null,
    })
    .select("event_id,status")
    .maybeSingle();
  if (!inserted.error) return { replayed: false };
  if (inserted.error.code !== "23505") {
    throw createHttpError(500, "DB_ERROR", inserted.error.message ?? "Failed to register webhook idempotency key");
  }

  const existing = await supabase
    .from("payu_webhook_events")
    .select("event_id,status")
    .eq("event_id", eventId)
    .maybeSingle();
  if (existing.error) {
    throw createHttpError(500, "DB_ERROR", existing.error.message ?? "Failed to read webhook idempotency row");
  }
  const existingStatus = ((existing.data as PayUWebhookEventRow | null)?.status ?? "processed").toLowerCase();
  if (existingStatus === "failed" || existingStatus === "deferred") {
    const retry = await supabase
      .from("payu_webhook_events")
      .update({
        status: "processing",
        request_id: requestId || null,
        event_type: eventType,
        event_created: eventCreated,
        txn_id: txnId,
        payment_id: paymentId,
        payu_status: payuStatus,
        payload,
        processed_at: null,
        last_error: null,
        defer_reason: null,
      })
      .eq("event_id", eventId);
    if (retry.error) {
      throw createHttpError(500, "DB_ERROR", retry.error.message ?? "Failed to reopen failed webhook event");
    }
    return { replayed: false };
  }
  return { replayed: true, replayStatus: existingStatus };
}

async function finalizePayUWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  status: "processed" | "ignored_stale" | "deferred",
  fields: {
    workspaceId?: string | null;
    txnId?: string | null;
    paymentId?: string | null;
    payuStatus?: string | null;
    requestId?: string;
    deferReason?: string | null;
  },
): Promise<void> {
  const finalize = await supabase
    .from("payu_webhook_events")
    .update({
      status,
      processed_at: status === "deferred" ? null : new Date().toISOString(),
      workspace_id: fields.workspaceId ?? null,
      txn_id: fields.txnId ?? null,
      payment_id: fields.paymentId ?? null,
      payu_status: fields.payuStatus ?? null,
      request_id: fields.requestId || null,
      defer_reason: status === "deferred" ? fields.deferReason ?? "deferred" : null,
      last_error: status === "deferred" ? fields.deferReason ?? "Webhook deferred" : null,
    })
    .eq("event_id", eventId);
  if (finalize.error) {
    throw createHttpError(500, "DB_ERROR", finalize.error.message ?? "Failed to finalize webhook event");
  }
}

async function failPayUWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  err: unknown,
): Promise<void> {
  const message = redact((err as Error)?.message, "message");
  const fail = await supabase
    .from("payu_webhook_events")
    .update({
      status: "failed",
      last_error: typeof message === "string" ? message : "Webhook processing failed",
      processed_at: null,
      defer_reason: null,
    })
    .eq("event_id", eventId);
  if (fail.error) {
    logger.error({
      event: "webhook_event_mark_failed_error",
      payu_event_id: eventId,
      error_message: fail.error.message,
      err: fail.error,
    });
  }
}

async function findWorkspaceForPayUEvent(
  supabase: SupabaseClient,
  workspaceHint: string | null,
  txnId: string | null,
): Promise<string | null> {
  if (workspaceHint) {
    const byHint = await supabase.from("workspaces").select("id").eq("id", workspaceHint).maybeSingle();
    if (byHint.data?.id) return byHint.data.id as string;
  }
  if (txnId) {
    const byTxn = await supabase.from("workspaces").select("id").eq("payu_txn_id", txnId).maybeSingle();
    if (byTxn.data?.id) return byTxn.data.id as string;
  }
  return null;
}

async function reconcilePayUWebhook(
  payload: PayUWebhookPayload,
  supabase: SupabaseClient,
  _env: Env,
  requestId = "",
  forcedEventId?: string,
): Promise<PayUReconcileWebhookResult> {
  const eventId = forcedEventId ?? resolvePayUEventId(payload);
  const eventType = resolvePayUEventType(payload);
  const eventCreated = resolvePayUEventCreated(payload);
  const claim = await claimPayUWebhookEvent(supabase, eventId, eventType, eventCreated, payload, requestId);
  if (claim.replayed) {
    return {
      outcome: "replayed",
      payuEventId: eventId,
      eventType,
      eventCreated,
      replayStatus: claim.replayStatus ?? null,
    };
  }

  const payuStatus = normalizePayUStatus(payload.status);
  const txnId = asNonEmptyString(payload.txnid);
  const paymentId = asNonEmptyString(payload.mihpayid);
  const workspaceHint = asNonEmptyString(payload.udf1);
  const workspaceId = await findWorkspaceForPayUEvent(supabase, workspaceHint, txnId);
  let deferReason: string | null = null;
  let outcome: "processed" | "ignored_stale" | "deferred" = "processed";

  try {
    if (!workspaceId) {
      deferReason = "workspace_not_found";
      outcome = "deferred";
    } else {
      const currentRow = await supabase
        .from("workspaces")
        .select("plan_status,payu_last_event_created,payu_last_event_id")
        .eq("id", workspaceId)
        .maybeSingle();
      if (currentRow.error) {
        throw createHttpError(500, "DB_ERROR", currentRow.error.message ?? "Failed to read billing cursor");
      }
      const current = currentRow.data as
        | {
          plan_status?: string;
          payu_last_event_created?: number | null;
          payu_last_event_id?: string | null;
        }
        | null;
      const shouldApply = shouldApplyPayUEvent(current?.payu_last_event_created, current?.payu_last_event_id, eventCreated, eventId);
      if (!shouldApply) {
        outcome = "ignored_stale";
      } else {
        const plan = planFromPayUStatus(payuStatus);
        const planStatus = planStatusFromPayUStatus(payuStatus);
        const oldStatus = normalizePlanStatus(current?.plan_status);
        const updatePayload = {
          billing_provider: "payu",
          payu_txn_id: txnId,
          payu_payment_id: paymentId,
          payu_last_status: payuStatus,
          payu_last_plan: plan,
          payu_last_event_id: eventId,
          payu_last_event_created: eventCreated,
          plan,
          plan_status: planStatus,
          current_period_end: paymentPeriodEndFromStatus(payuStatus),
          cancel_at_period_end: false,
          updated_at: new Date().toISOString(),
        };
        const updated = await supabase.from("workspaces").update(updatePayload).eq("id", workspaceId);
        if (updated.error) {
          throw createHttpError(500, "DB_ERROR", updated.error.message ?? "Failed to update PayU billing state");
        }
        if ((planStatus === "active" || planStatus === "trialing") && !(oldStatus === "active" || oldStatus === "trialing")) {
          void emitProductEvent(
            supabase,
            "upgrade_activated",
            {
              workspaceId,
              requestId,
              route: "/v1/billing/webhook",
              method: "POST",
              status: 200,
              effectivePlan: plan,
              planStatus,
            },
          );
        }
      }
    }

    await finalizePayUWebhookEvent(
      supabase,
      eventId,
      outcome,
      { workspaceId, txnId, paymentId, payuStatus, requestId, deferReason },
    );
  } catch (err) {
    await failPayUWebhookEvent(supabase, eventId, err);
    throw err;
  }

  return {
    outcome,
    payuEventId: eventId,
    eventType,
    eventCreated,
    workspaceId,
    txnId,
    paymentId,
    deferReason,
  };
}


