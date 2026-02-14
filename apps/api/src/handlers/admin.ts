/**
 * Admin handlers (reprocess deferred webhooks, billing health). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * PayU/billing logic stays in index; dependencies injected via AdminHandlerDeps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { HandlerDeps } from "../router.js";
import type { PayUWebhookPayloadLike } from "./webhooks.js";
import type { ReconcileOutcomeLike } from "./webhooks.js";

export interface AdminHandlerDeps extends HandlerDeps {
  requireAdmin: (request: Request, env: Env) => Promise<{ token: string }>;
  rateLimit: (keyHash: string, env: Env) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
  emitEventLog: (event_name: string, fields: Record<string, unknown>) => void;
  redact: (value: unknown, keyHint?: string) => unknown;
  reconcilePayUWebhook: (
    payload: PayUWebhookPayloadLike,
    supabase: SupabaseClient,
    env: Env,
    requestId: string,
    forcedEventId?: string,
  ) => Promise<ReconcileOutcomeLike>;
  defaultWebhookReprocessLimit: number;
  asNonEmptyString: (raw: unknown) => string | null;
  resolvePayUVerifyTimeoutMs: (env: Env) => number;
  resolveBillingWebhooksEnabled: (env: Env) => boolean;
  normalizeCurrency: (raw: string | undefined) => string;
}

export function createAdminHandlers(
  requestDeps: AdminHandlerDeps,
  defaultDeps: AdminHandlerDeps,
): {
  handleReprocessDeferredWebhooks: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleAdminBillingHealth: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleReprocessDeferredWebhooks(request, env, supabase, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as AdminHandlerDeps;
      const { jsonResponse } = d;
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:${token}`, env);
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
      const parsedLimit = Number(url.searchParams.get("limit") ?? d.defaultWebhookReprocessLimit);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(500, Math.floor(parsedLimit)))
        : d.defaultWebhookReprocessLimit;

      d.emitEventLog("webhook_reprocess_started", {
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
        .filter((row) => typeof row.event_id === "string" && (row.event_id as string).trim().length > 0) as Array<{
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
          const payload = (row.payload ?? {}) as PayUWebhookPayloadLike;
          const outcome = await d.reconcilePayUWebhook(
            payload,
            supabase,
            env,
            `${requestId || "admin-reprocess"}:${row.event_id}`,
            row.event_id,
          );
          if (outcome.outcome === "replayed") {
            replayed += 1;
            d.emitEventLog("webhook_reprocess_skipped", {
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
            d.emitEventLog("webhook_reprocess_skipped", {
              route: "/admin/webhooks/reprocess",
              method: "POST",
              request_id: requestId || null,
              payu_event_id: row.event_id,
              reason: outcome.deferReason ?? "workspace_not_found",
            });
            continue;
          }
          processed += 1;
          d.emitEventLog("webhook_reprocess_processed", {
            route: "/admin/webhooks/reprocess",
            method: "POST",
            request_id: requestId || null,
            payu_event_id: row.event_id,
            outcome: outcome.outcome,
          });
        } catch (err) {
          failed += 1;
          d.emitEventLog("webhook_reprocess_failed", {
            route: "/admin/webhooks/reprocess",
            method: "POST",
            request_id: requestId || null,
            payu_event_id: row.event_id,
            error_message: d.redact((err as Error)?.message, "message"),
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
    },

    async handleAdminBillingHealth(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as AdminHandlerDeps;
      const { jsonResponse } = d;
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:${token}`, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const nowIso = new Date().toISOString();
      const verifyUrl = d.asNonEmptyString(env.PAYU_VERIFY_URL);
      let verifyHost: string | null = null;
      if (verifyUrl) {
        try {
          verifyHost = new URL(verifyUrl).host;
        } catch {
          verifyHost = null;
        }
      }

      const dbProbe = await supabase.from("workspaces").select("id").limit(1);
      const dbConnectivity = {
        ok: !dbProbe.error,
        error_code: dbProbe.error?.code ?? null,
        error_message: dbProbe.error ? d.redact(dbProbe.error.message ?? "DB probe failed", "message") : null,
      };

      const webhookRows = await supabase
        .from("payu_webhook_events")
        .select("event_id,status,payu_status,event_created,processed_at,defer_reason,last_error")
        .order("event_created", { ascending: false })
        .limit(10);
      const webhookSummary = {
        ok: !webhookRows.error,
        error_code: webhookRows.error?.code ?? null,
        error_message: webhookRows.error ? d.redact(webhookRows.error.message ?? "Webhook query failed", "message") : null,
        items: ((webhookRows.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
          event_id_redacted: d.redact(row.event_id, "payu_event_id"),
          status: typeof row.status === "string" ? row.status : null,
          payu_status: typeof row.payu_status === "string" ? row.payu_status : null,
          event_created: typeof row.event_created === "number" ? row.event_created : null,
          processed_at: typeof row.processed_at === "string" ? row.processed_at : null,
          defer_reason: typeof row.defer_reason === "string" ? row.defer_reason : null,
          last_error: typeof row.last_error === "string" ? d.redact(row.last_error, "message") : null,
        })),
      };

      const txnRows = await supabase
        .from("payu_transactions")
        .select("txn_id,workspace_id,plan_code,status,amount,currency,verify_status,updated_at,last_error")
        .order("updated_at", { ascending: false })
        .limit(10);
      const transactionSummary = {
        ok: !txnRows.error,
        error_code: txnRows.error?.code ?? null,
        error_message: txnRows.error ? d.redact(txnRows.error.message ?? "Transaction query failed", "message") : null,
        items: ((txnRows.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
          txn_id_redacted: d.redact(row.txn_id, "payu_txn_id"),
          workspace_id_redacted: d.redact(row.workspace_id, "workspace_id"),
          plan_code: typeof row.plan_code === "string" ? row.plan_code : null,
          status: typeof row.status === "string" ? row.status : null,
          amount: typeof row.amount === "number" || typeof row.amount === "string" ? String(row.amount) : null,
          currency: typeof row.currency === "string" ? row.currency : null,
          verify_status: typeof row.verify_status === "string" ? row.verify_status : null,
          updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
          last_error: typeof row.last_error === "string" ? d.redact(row.last_error, "message") : null,
        })),
      };

      return jsonResponse(
        {
          now: nowIso,
          billing_webhooks_enabled: d.resolveBillingWebhooksEnabled(env),
          payu_verify: {
            configured: Boolean(verifyUrl),
            host: verifyHost,
            timeout_ms: d.resolvePayUVerifyTimeoutMs(env),
            currency: d.normalizeCurrency(env.PAYU_CURRENCY),
          },
          db_connectivity: dbConnectivity,
          payu_webhook_events: webhookSummary,
          payu_transactions: transactionSummary,
        },
        200,
        rate.headers,
      );
    },
  };
}
